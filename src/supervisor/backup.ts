import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { paths } from '../core/paths.js';
import { tryLoadHostConfiguration } from '../core/configuration.js';
import type { CommandRunner } from './execute.js';

const run: CommandRunner = (executable, arguments_) => { execFileSync(executable, [...arguments_], { stdio: 'inherit', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } }); };
const keyId = 'application-backup-kek-v1', credentialPath = `/etc/treeseed/credentials/${keyId}.cred`;
const schemaVersion = 'treeseed.encrypted-backup/v1' as const, blockSize = 1024 * 1024;
function archivePath(generation: number, root: string = paths.backups) { return `${root}/generation-${generation}.tar.gz.enc`; }
function legacyArchivePath(generation: number, root: string = paths.backups) { return `${root}/generation-${generation}.tar.gz`; }
function encryptionRequired() { return existsSync(`${paths.securityState}/initialized.json`) || Boolean(tryLoadHostConfiguration()?.security); }
function temporaryArchive(generation: number, root = '/run/treeseed') { return `${root}/backup-generation-${generation}.tar.gz`; }
function canonical(value: Record<string, unknown>) { return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))); }
function loadKey(override?: Buffer) {
	if (override) { if (override.byteLength !== 32) throw new Error('Backup encryption key must contain exactly 32 bytes.'); return Buffer.from(override); }
	const plaintext = execFileSync('/usr/bin/systemd-creds', ['decrypt', `--name=${keyId}`, credentialPath, '-']);
	try { const decoded = Buffer.from(plaintext.toString('utf8').trim(), 'base64url'); if (decoded.byteLength !== 32) throw new Error('Backup encryption credential is invalid.'); return decoded; }
	finally { plaintext.fill(0); }
}
function checksum(path: string) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function expectedChecksum(path: string) { return readFileSync(`${path}.sha256`, 'utf8').split(/\s+/u)[0] ?? ''; }
function transformFile(inputPath: string, outputPath: string, transform: { update(value: Buffer): Buffer; final(): Buffer }) {
	const input = openSync(inputPath, 'r'), output = openSync(outputPath, 'wx', 0o600), buffer = Buffer.allocUnsafe(blockSize);
	try { let count = 0; while ((count = readSync(input, buffer, 0, buffer.byteLength, null)) > 0) { const value = transform.update(buffer.subarray(0, count)); if (value.byteLength) writeSync(output, value); } const final = transform.final(); if (final.byteLength) writeSync(output, final); }
	finally { buffer.fill(0); closeSync(input); closeSync(output); }
}
function encryptArchive(plaintextPath: string, target: string, generation: number, key: Buffer) {
	const nonce = randomBytes(12), header = { schemaVersion, algorithm: 'aes-256-gcm', keyId, generation, nonce: nonce.toString('base64url'), createdAt: new Date().toISOString() } as const;
	const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(Buffer.from(canonical(header)));
	const ciphertext = `${target}.ciphertext`; transformFile(plaintextPath, ciphertext, cipher);
	const output = openSync(`${target}.new`, 'wx', 0o600), encrypted = openSync(ciphertext, 'r'), buffer = Buffer.allocUnsafe(blockSize);
	try { writeSync(output, Buffer.from(`${JSON.stringify(header)}\n`)); let count = 0; while ((count = readSync(encrypted, buffer, 0, buffer.byteLength, null)) > 0) writeSync(output, buffer.subarray(0, count)); writeSync(output, cipher.getAuthTag()); }
	finally { buffer.fill(0); closeSync(encrypted); closeSync(output); rmSync(ciphertext, { force: true }); }
	renameSync(`${target}.new`, target); return header;
}
function decryptArchive(source: string, target: string, generation: number, key: Buffer) {
	const descriptor = openSync(source, 'r'), prefix = Buffer.alloc(4096); let count = 0, sourceSize = 0;
	try { count = readSync(descriptor, prefix, 0, prefix.byteLength, 0); sourceSize = fstatSync(descriptor).size; } finally { closeSync(descriptor); }
	const newline = prefix.subarray(0, count).indexOf(10); if (newline < 1) throw new Error('Encrypted backup header is missing or oversized.');
	const header = JSON.parse(prefix.subarray(0, newline).toString('utf8')) as Record<string, unknown>;
	if (header.schemaVersion !== schemaVersion || header.algorithm !== 'aes-256-gcm' || header.keyId !== keyId || header.generation !== generation) throw new Error('Encrypted backup header does not match the requested generation.');
	const nonce = Buffer.from(String(header.nonce), 'base64url'); if (nonce.byteLength !== 12) throw new Error('Encrypted backup nonce is invalid.');
	const ciphertextStart = newline + 1, ciphertextBytes = sourceSize - ciphertextStart - 16; if (ciphertextBytes < 1) throw new Error('Encrypted backup payload is truncated.');
	const sourceFd = openSync(source, 'r'), targetFd = openSync(target, 'wx', 0o600), decipher = createDecipheriv('aes-256-gcm', key, nonce), buffer = Buffer.allocUnsafe(blockSize), tag = Buffer.alloc(16);
	try {
		decipher.setAAD(Buffer.from(canonical(header))); readSync(sourceFd, tag, 0, 16, sourceSize - 16); decipher.setAuthTag(tag);
		let offset = ciphertextStart, remaining = ciphertextBytes; while (remaining > 0) { const wanted = Math.min(buffer.byteLength, remaining), read = readSync(sourceFd, buffer, 0, wanted, offset); if (!read) throw new Error('Encrypted backup ended unexpectedly.'); const value = decipher.update(buffer.subarray(0, read)); if (value.byteLength) writeSync(targetFd, value); offset += read; remaining -= read; }
		const final = decipher.final(); if (final.byteLength) writeSync(targetFd, final);
	} finally { buffer.fill(0); tag.fill(0); closeSync(sourceFd); closeSync(targetFd); }
	return header;
}

const archivedState = { configuration: 'etc/treeseed/platform.json', receipt: 'var/lib/treeseed/manager/current-receipt.json', components: 'var/lib/treeseed/manager/active-components.json' } as const;
type ArchiveReader = (archive: string, member: string) => string;
const readArchive: ArchiveReader = (archive, member) => execFileSync('/usr/bin/tar', ['--extract', '--to-stdout', '--gzip', '--file', archive, member], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
function archivedJson(archive: string, member: string, reader: ArchiveReader) { try { return JSON.parse(reader(archive, member)) as unknown; } catch { return null; } }

export function inspectGenerationBackup(generation: number, options: { backupRoot?: string; stagingRoot?: string; reader?: ArchiveReader; key?: Buffer } = {}) {
	const archive = archivePath(generation, options.backupRoot), checksumPath = `${archive}.sha256`;
	if (!existsSync(archive)) {
		const legacy = legacyArchivePath(generation, options.backupRoot); if (!existsSync(legacy) || !existsSync(`${legacy}.sha256`)) throw new Error(`Recovery generation ${generation} does not exist.`);
		if (encryptionRequired()) throw new Error(`Recovery generation ${generation} is an unencrypted legacy backup and is prohibited after security cutover.`);
		const expected = expectedChecksum(legacy), actual = checksum(legacy); if (expected !== actual) throw new Error(`Recovery generation ${generation} failed checksum verification.`); const reader = options.reader ?? readArchive;
		return { generation, sha256: actual, encrypted: false as const, configuration: archivedJson(legacy, archivedState.configuration, reader), receipt: archivedJson(legacy, archivedState.receipt, reader), components: archivedJson(legacy, archivedState.components, reader) };
	}
	if (!existsSync(checksumPath)) throw new Error(`Recovery generation ${generation} does not exist.`);
	const expected = expectedChecksum(archive), actual = checksum(archive); if (expected !== actual) throw new Error(`Recovery generation ${generation} failed checksum verification.`);
	const stagingRoot = options.stagingRoot ?? '/run/treeseed'; mkdirSync(stagingRoot, { recursive: true, mode: 0o700 }); const plaintext = temporaryArchive(generation, stagingRoot), key = loadKey(options.key);
	try { const envelope = decryptArchive(archive, plaintext, generation, key), reader = options.reader ?? readArchive; return { generation, sha256: actual, encrypted: true as const, envelope, configuration: archivedJson(plaintext, archivedState.configuration, reader), receipt: archivedJson(plaintext, archivedState.receipt, reader), components: archivedJson(plaintext, archivedState.components, reader) }; }
	finally { key.fill(0); rmSync(plaintext, { force: true }); }
}
export function listGenerationBackups(options: { backupRoot?: string; stagingRoot?: string; reader?: ArchiveReader; key?: Buffer } = {}) {
	const root = options.backupRoot ?? paths.backups; if (!existsSync(root)) return [];
	return [...new Set(readdirSync(root).flatMap((name) => { const match = name.match(/^generation-([1-9][0-9]*)\.tar\.gz(?:\.enc)?$/u); return match ? [Number(match[1])] : []; }))].sort((left, right) => right - left)
		.map((generation) => { try { return { ...inspectGenerationBackup(generation, options), valid: true as const }; } catch (error) { return { generation, valid: false as const, error: error instanceof Error ? error.message : String(error) }; } });
}
export function createGenerationBackup(generation: number, command: CommandRunner = run) {
	mkdirSync(paths.backups, { recursive: true, mode: 0o700 }); mkdirSync('/run/treeseed', { recursive: true, mode: 0o700 });
	const archive = archivePath(generation), plaintext = temporaryArchive(generation), members = ['etc/treeseed', 'var/lib/treeseed/components', 'var/lib/treeseed/manager/current-receipt.json', 'var/lib/treeseed/manager/active-components.json'].filter((member) => existsSync(`/${member}`));
	if (members.length === 0) throw new Error('No managed TreeSeed state exists to back up.'); if (existsSync(archive) || existsSync(plaintext)) throw new Error(`Recovery generation ${generation} already exists or has an unfinished staging file.`);
	if (!existsSync(credentialPath)) {
		if (encryptionRequired()) throw new Error('Encrypted generation backup key is unavailable after security cutover.'); const legacy = legacyArchivePath(generation); if (existsSync(legacy)) throw new Error(`Recovery generation ${generation} already exists.`);
		command('/usr/bin/tar', ['--create', '--gzip', '--file', `${legacy}.new`, '--directory', '/', '--numeric-owner', ...members]); renameSync(`${legacy}.new`, legacy); const sha256 = checksum(legacy); writeFileSync(`${legacy}.sha256`, `${sha256}  generation-${generation}.tar.gz\n`, { mode: 0o600 }); return { generation, archive: legacy, sha256, encrypted: false as const };
	}
	command('/usr/bin/tar', ['--create', '--gzip', '--file', plaintext, '--directory', '/', '--numeric-owner', ...members]); const key = loadKey();
	try { encryptArchive(plaintext, archive, generation, key); } finally { key.fill(0); rmSync(plaintext, { force: true }); }
	const sha256 = checksum(archive); writeFileSync(`${archive}.sha256`, `${sha256}  generation-${generation}.tar.gz.enc\n`, { mode: 0o600 });
	const retained = readdirSync(paths.backups).filter((name) => /^generation-[1-9][0-9]*\.tar\.gz\.enc$/u.test(name)).sort((left, right) => Number(right.slice(11, -11)) - Number(left.slice(11, -11)));
	for (const stale of retained.slice(10)) { rmSync(`${paths.backups}/${stale}`, { force: true }); rmSync(`${paths.backups}/${stale}.sha256`, { force: true }); }
	return { generation, archive, sha256, encrypted: true as const };
}
export function restoreGenerationBackup(generation: number, command: CommandRunner = run) {
	const archive = archivePath(generation);
	if (!existsSync(archive)) {
		const legacy = legacyArchivePath(generation); if (!existsSync(legacy) || !existsSync(`${legacy}.sha256`)) throw new Error(`Recovery generation ${generation} does not exist.`);
		if (encryptionRequired()) throw new Error('Unencrypted recovery generations cannot be restored after security cutover.'); const expected = expectedChecksum(legacy), actual = checksum(legacy); if (expected !== actual) throw new Error(`Recovery generation ${generation} failed checksum verification.`);
		command('/usr/bin/tar', ['--extract', '--gzip', '--file', legacy, '--directory', '/', '--numeric-owner', '--no-overwrite-dir']); return { generation, restored: true, sha256: actual, encrypted: false as const };
	}
	if (!existsSync(`${archive}.sha256`)) throw new Error(`Recovery generation ${generation} does not exist.`);
	const expected = expectedChecksum(archive), actual = checksum(archive); if (expected !== actual) throw new Error(`Recovery generation ${generation} failed checksum verification.`);
	mkdirSync('/run/treeseed', { recursive: true, mode: 0o700 }); const plaintext = temporaryArchive(generation), key = loadKey();
	try { decryptArchive(archive, plaintext, generation, key); command('/usr/bin/tar', ['--extract', '--gzip', '--file', plaintext, '--directory', '/', '--numeric-owner', '--no-overwrite-dir']); }
	finally { key.fill(0); rmSync(plaintext, { force: true }); }
	return { generation, restored: true, sha256: actual, encrypted: true as const };
}

import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { paths } from '../core/paths.js';
import { loadHostConfiguration } from '../core/configuration.js';
import { assertBackupEntries, assertBackupStatePaths, requiredBackupState } from './backup-coverage.js';
import { backupKeyId, decryptBackupStream, encryptBackupStream, inspectBackupStream } from './backup-stream.js';
import { assertNoBackupWriters } from './backup-writers.js';

const credentialPath = `/etc/treeseed/credentials/${backupKeyId}.cred`;
function archivePath(generation: number, root: string = paths.backups) {
	if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('Backup generation is invalid.');
	return `${root}/generation-${generation}.tar.gz.enc`;
}
function loadKey(override?: Buffer) {
	if (override) { if (override.length !== 32) throw new Error('Backup encryption key must contain exactly 32 bytes.'); return Buffer.from(override); }
	const plaintext = execFileSync('/usr/bin/systemd-creds', ['decrypt', `--name=${backupKeyId}`, credentialPath, '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
	try { const key = Buffer.from(plaintext.toString('utf8').trim(), 'base64url'); if (key.length !== 32) throw new Error('Backup encryption credential is invalid.'); return key; }
	finally { plaintext.fill(0); }
}
function checksum(path: string) { return execFileSync('/usr/bin/sha256sum', [path], { encoding: 'utf8' }).split(/\s/u)[0]!; }
function checkedArchive(generation: number, root?: string) {
	const path = archivePath(generation, root);
	if (!existsSync(path) || !existsSync(`${path}.sha256`)) throw new Error(`Recovery generation ${generation} does not exist.`);
	if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Recovery archive is not a regular file.');
	const sha256 = checksum(path), expected = readFileSync(`${path}.sha256`, 'utf8').split(/\s/u)[0];
	if (sha256 !== expected) throw new Error(`Recovery generation ${generation} failed checksum verification.`);
	return { path, sha256 };
}

export async function inspectGenerationBackup(generation: number, options: { backupRoot?: string; key?: Buffer } = {}) {
	const { path, sha256 } = checkedArchive(generation, options.backupRoot), key = loadKey(options.key);
	try {
		const { entries, ...state } = await inspectBackupStream(path, generation, key);
		const coverage = assertBackupEntries(state.configuration, state.components, entries);
		return { generation, sha256, encrypted: true as const, ...state, coverage };
	} finally { key.fill(0); }
}
export async function listGenerationBackups(options: { backupRoot?: string; key?: Buffer } = {}) {
	const root = options.backupRoot ?? paths.backups; if (!existsSync(root)) return [];
	const generations = readdirSync(root).flatMap(name => { const match = /^generation-([1-9][0-9]*)\.tar\.gz\.enc$/u.exec(name); return match ? [Number(match[1])] : []; }).sort((a, b) => b - a);
	const results = [];
	for (const generation of generations) {
		try { results.push({ ...await inspectGenerationBackup(generation, options), valid: true as const }); }
		catch (error) { results.push({ generation, valid: false as const, error: error instanceof Error ? error.message : String(error) }); }
	}
	return results;
}
export async function createGenerationBackup(generation: number) {
	const host = loadHostConfiguration(), components = JSON.parse(readFileSync(`${paths.managerState}/active-components.json`, 'utf8'));
	const state = requiredBackupState(host, components); assertBackupStatePaths(state);
	assertNoBackupWriters(state);
	const members = ['etc/treeseed', 'var/lib/treeseed/manager/current-receipt.json', 'var/lib/treeseed/manager/active-components.json', ...state];
	mkdirSync(paths.backups, { recursive: true, mode: 0o700 });
	const archive = archivePath(generation), temporary = `${archive}.new`, key = loadKey();
	if (existsSync(archive) || existsSync(temporary)) { key.fill(0); throw new Error('Recovery generation already exists or has an unfinished staging file.'); }
	const child = spawn('/usr/bin/tar', ['--create', '--gzip', '--file', '-', '--directory', '/', '--numeric-owner', ...members], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } });
	child.stderr.resume();
	try {
		const [exit] = await Promise.all([once(child, 'exit'), encryptBackupStream(child.stdout, temporary, generation, key)]);
		if (exit[0] !== 0) throw new Error('Required managed state could not be archived consistently.');
		renameSync(temporary, archive);
		const sha256 = checksum(archive); writeFileSync(`${archive}.sha256`, `${sha256}  generation-${generation}.tar.gz.enc\n`, { mode: 0o600 });
		const retained = readdirSync(paths.backups).filter(name => /^generation-[1-9][0-9]*\.tar\.gz\.enc$/u.test(name)).sort((a, b) => Number(b.slice(11, -11)) - Number(a.slice(11, -11)));
		for (const stale of retained.slice(10)) { rmSync(`${paths.backups}/${stale}`, { force: true }); rmSync(`${paths.backups}/${stale}.sha256`, { force: true }); }
		return { generation, archive, sha256, encrypted: true as const, stateDirectories: state };
	} finally { child.kill(); key.fill(0); rmSync(temporary, { force: true }); }
}
export async function restoreVerifiedBackup(generation: number, options: { backupRoot: string; destinationRoot: string; key: Buffer; checkWriters: (members: string[]) => void }) {
	// Inspect and extract the same private encrypted snapshot. Never stream newly
	// opened, potentially replaced ciphertext into the live filesystem.
	const source = checkedArchive(generation, options.backupRoot);
	const snapshotRoot = mkdtempSync(`${options.backupRoot}/restore-`);
	const path = archivePath(generation, snapshotRoot);
	try {
	copyFileSync(source.path, path, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
	writeFileSync(`${path}.sha256`, source.sha256, { mode: 0o600 });
	const inspected = await inspectGenerationBackup(generation, { backupRoot: snapshotRoot, key: options.key });
	options.checkWriters(inspected.coverage.stateDirectories);
	const sha256 = inspected.sha256;
	const key = Buffer.from(options.key);
	const child = spawn('/usr/bin/tar', ['--extract', '--gzip', '--file', '-', '--directory', options.destinationRoot, '--numeric-owner', '--no-overwrite-dir'], { stdio: ['pipe', 'ignore', 'pipe'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } });
	child.stderr.resume();
	try {
		const [exit] = await Promise.all([once(child, 'exit'), decryptBackupStream(path, generation, key, child.stdin)]);
		if (exit[0] !== 0) throw new Error('Managed recovery extraction failed.');
		return { generation, restored: true, sha256, encrypted: true as const };
	} finally { child.kill(); key.fill(0); }
	} finally { rmSync(snapshotRoot, { recursive: true, force: true }); }
}
export async function restoreGenerationBackup(generation: number) {
	const key = loadKey();
	try { return await restoreVerifiedBackup(generation, { backupRoot: paths.backups, destinationRoot: '/', key, checkWriters: assertNoBackupWriters }); }
	finally { key.fill(0); }
}

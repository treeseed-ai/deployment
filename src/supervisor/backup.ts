import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { paths } from '../core/paths.js';
import type { CommandRunner } from './execute.js';

const run: CommandRunner = (executable, arguments_) => { execFileSync(executable, [...arguments_], { stdio: 'inherit', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } }); };

function archivePath(generation: number) { return `${paths.backups}/generation-${generation}.tar.gz`; }

const archivedState = {
	configuration: 'etc/treeseed/platform.json',
	receipt: 'var/lib/treeseed/manager/current-receipt.json',
	components: 'var/lib/treeseed/manager/active-components.json',
} as const;

type ArchiveReader = (archive: string, member: string) => string;
const readArchive: ArchiveReader = (archive, member) => execFileSync('/usr/bin/tar', [
	'--extract', '--to-stdout', '--gzip', '--file', archive, member,
], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

function checksum(archive: string) {
	return createHash('sha256').update(readFileSync(archive)).digest('hex');
}

function expectedChecksum(archive: string) {
	return readFileSync(`${archive}.sha256`, 'utf8').split(/\s+/u)[0] ?? '';
}

function archivedJson(archive: string, member: string, reader: ArchiveReader) {
	try { return JSON.parse(reader(archive, member)) as unknown; }
	catch { return null; }
}

export function inspectGenerationBackup(
	generation: number,
	options: { backupRoot?: string; reader?: ArchiveReader } = {},
) {
	const root = options.backupRoot ?? paths.backups;
	const archive = `${root}/generation-${generation}.tar.gz`, checksumPath = `${archive}.sha256`;
	if (!existsSync(archive) || !existsSync(checksumPath)) throw new Error(`Recovery generation ${generation} does not exist.`);
	const expected = expectedChecksum(archive), actual = checksum(archive);
	if (expected !== actual) throw new Error(`Recovery generation ${generation} failed checksum verification.`);
	const reader = options.reader ?? readArchive;
	return {
		generation,
		sha256: actual,
		configuration: archivedJson(archive, archivedState.configuration, reader),
		receipt: archivedJson(archive, archivedState.receipt, reader),
		components: archivedJson(archive, archivedState.components, reader),
	};
}

export function listGenerationBackups(options: { backupRoot?: string; reader?: ArchiveReader } = {}) {
	const root = options.backupRoot ?? paths.backups;
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.flatMap((name) => {
			const match = name.match(/^generation-([1-9][0-9]*)\.tar\.gz$/u);
			return match ? [Number(match[1])] : [];
		})
		.sort((left, right) => right - left)
		.map((generation) => {
			try { return { ...inspectGenerationBackup(generation, options), valid: true as const }; }
			catch (error) { return { generation, valid: false as const, error: error instanceof Error ? error.message : String(error) }; }
		});
}

export function createGenerationBackup(generation: number, command: CommandRunner = run) {
	mkdirSync(paths.backups, { recursive: true, mode: 0o700 });
	const archive = archivePath(generation), temporary = `${archive}.new`;
	const members = ['etc/treeseed', 'var/lib/treeseed/components', 'var/lib/treeseed/manager/current-receipt.json', 'var/lib/treeseed/manager/active-components.json'].filter((member) => existsSync(`/${member}`));
	if (members.length === 0) throw new Error('No managed TreeSeed state exists to back up.');
	command('/usr/bin/tar', ['--create', '--gzip', '--file', temporary, '--directory', '/', '--numeric-owner', ...members]);
	renameSync(temporary, archive);
	const sha256 = checksum(archive);
	writeFileSync(`${archive}.sha256`, `${sha256}  generation-${generation}.tar.gz\n`, { mode: 0o600 });
	const retained = readdirSync(paths.backups).filter((name) => /^generation-[1-9][0-9]*\.tar\.gz$/u.test(name)).sort((left, right) => Number(right.slice(11, -7)) - Number(left.slice(11, -7)));
	for (const stale of retained.slice(10)) {
		rmSync(`${paths.backups}/${stale}`, { force: true });
		rmSync(`${paths.backups}/${stale}.sha256`, { force: true });
	}
	return { generation, archive, sha256 };
}

export function restoreGenerationBackup(generation: number, command: CommandRunner = run) {
	const archive = archivePath(generation), checksumPath = `${archive}.sha256`;
	if (!existsSync(archive) || !existsSync(checksumPath)) throw new Error(`Recovery generation ${generation} does not exist.`);
	const expected = expectedChecksum(archive);
	const actual = checksum(archive);
	if (expected !== actual) throw new Error(`Recovery generation ${generation} failed checksum verification.`);
	command('/usr/bin/tar', ['--extract', '--gzip', '--file', archive, '--directory', '/', '--numeric-owner', '--no-overwrite-dir']);
	return { generation, restored: true, sha256: actual };
}

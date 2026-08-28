import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { paths } from '../core/paths.js';
import type { CommandRunner } from './execute.js';

const run: CommandRunner = (executable, arguments_) => { execFileSync(executable, [...arguments_], { stdio: 'inherit', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } }); };

function archivePath(generation: number) { return `${paths.backups}/generation-${generation}.tar.gz`; }

export function createGenerationBackup(generation: number, command: CommandRunner = run) {
	mkdirSync(paths.backups, { recursive: true, mode: 0o700 });
	const archive = archivePath(generation), temporary = `${archive}.new`;
	const members = ['etc/treeseed', 'usr/share/treeseed/components', 'var/lib/treeseed/components', 'var/lib/treeseed/manager/current-receipt.json', 'var/lib/treeseed/manager/active-components.json'].filter((member) => existsSync(`/${member}`));
	if (members.length === 0) throw new Error('No managed TreeSeed state exists to back up.');
	command('/usr/bin/tar', ['--create', '--gzip', '--file', temporary, '--directory', '/', '--numeric-owner', ...members]);
	renameSync(temporary, archive);
	const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
	writeFileSync(`${archive}.sha256`, `${sha256}  generation-${generation}.tar.gz\n`, { mode: 0o600 });
	const retained = readdirSync(paths.backups).filter((name) => /^generation-[1-9][0-9]*\.tar\.gz$/u.test(name)).sort((left, right) => Number(right.slice(11, -7)) - Number(left.slice(11, -7)));
	for (const stale of retained.slice(10)) {
		rmSync(`${paths.backups}/${stale}`, { force: true });
		rmSync(`${paths.backups}/${stale}.sha256`, { force: true });
	}
	return { generation, archive, sha256 };
}

export function restoreGenerationBackup(generation: number, command: CommandRunner = run) {
	const archive = archivePath(generation), checksum = `${archive}.sha256`;
	if (!existsSync(archive) || !existsSync(checksum)) throw new Error(`Recovery generation ${generation} does not exist.`);
	const expected = readFileSync(checksum, 'utf8').split(/\s+/u)[0];
	const actual = createHash('sha256').update(readFileSync(archive)).digest('hex');
	if (expected !== actual) throw new Error(`Recovery generation ${generation} failed checksum verification.`);
	command('/usr/bin/tar', ['--extract', '--gzip', '--file', archive, '--directory', '/', '--numeric-owner', '--no-overwrite-dir']);
	return { generation, restored: true, sha256: actual };
}

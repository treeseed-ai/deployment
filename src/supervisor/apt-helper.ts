import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync } from 'node:fs';
import { paths } from '../core/paths.js';
import { supervisorOperationSchema } from './protocol.js';

export function applyPendingPackages() {
	if (process.getuid?.() !== 0) throw new Error('APT helper must run as root.');
	const path = `${paths.managerState}/pending-packages.json`;
	const operation = supervisorOperationSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
	if (operation.operation !== 'apt.install') throw new Error('Pending operation is not an APT installation.');
	execFileSync('/usr/bin/apt-get', ['--yes', '--no-install-recommends', '-o', 'Dpkg::Options::=--force-confold', 'install', ...operation.packages], { stdio: 'inherit', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', DEBIAN_FRONTEND: 'noninteractive' } });
	renameSync(path, `${paths.managerState}/last-packages.json`);
}

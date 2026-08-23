import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync } from 'node:fs';
import { paths } from '../core/paths.js';
import { atomicJson } from '../core/files.js';
import { supervisorOperationSchema } from './protocol.js';

export type AptCommandRunner = (executable: string, arguments_: readonly string[]) => void;
const run: AptCommandRunner = (executable, arguments_) => { execFileSync(executable, [...arguments_], { stdio: 'inherit', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', DEBIAN_FRONTEND: 'noninteractive' } }); };
const transactionOptions = ['--yes', '--allow-downgrades', '--no-remove', '--no-install-recommends', '-o', 'DPkg::Lock::Timeout=600', '-o', 'Dpkg::Options::=--force-confold'] as const;
const corePackages = ['treeseed-host-runtime', 'treeseed-manager', 'treeseed-sdk', 'treeseed-cli', 'treeseed-edge'] as const;

function installedCoreVersions() {
	return Object.fromEntries(corePackages.map((name) => {
		try { return [name, execFileSync('/usr/bin/dpkg-query', ['--show', '--showformat=${Version}', name], { encoding: 'utf8' }).trim()]; }
		catch { return [name, null]; }
	}));
}

export function applyPendingPackages(command: AptCommandRunner = run) {
	if (process.getuid?.() !== 0) throw new Error('APT helper must run as root.');
	const path = `${paths.managerState}/pending-packages.json`;
	const operation = supervisorOperationSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
	if (operation.operation === 'apt.install') command('/usr/bin/apt-get', [...transactionOptions, 'install', ...operation.packages]);
	else if (operation.operation === 'apt.refresh') {
		const before = operation.updateCore ? installedCoreVersions() : {};
		command('/usr/bin/apt-get', ['-o', 'DPkg::Lock::Timeout=600', 'update']);
		const packages = ['treeseed-release-catalog'];
		if (operation.updateCore) packages.push(...corePackages);
		command('/usr/bin/apt-get', [...transactionOptions, '--only-upgrade', '--target-release', operation.track, 'install', ...packages]);
		const after = operation.updateCore ? installedCoreVersions() : {};
		atomicJson(`${paths.managerState}/last-apt-result.json`, { track: operation.track, coreUpdated: operation.updateCore && JSON.stringify(before) !== JSON.stringify(after), before, after }, 0o600);
	} else throw new Error('Pending operation is not an APT transaction.');
	renameSync(path, `${paths.managerState}/last-packages.json`);
}

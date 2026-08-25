import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { paths } from '../core/paths.js';
import { atomicJson } from '../core/files.js';
import { supervisorOperationSchema } from './protocol.js';

export type AptCommandRunner = (executable: string, arguments_: readonly string[]) => void;
const run: AptCommandRunner = (executable, arguments_) => { execFileSync(executable, [...arguments_], { stdio: 'inherit', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', DEBIAN_FRONTEND: 'noninteractive' } }); };
const transactionOptions = ['--yes', '--allow-downgrades', '--no-remove', '--no-install-recommends', '-o', 'DPkg::Lock::Timeout=600', '-o', 'Dpkg::Options::=--force-confold'] as const;
const requiredCorePackages = ['treeseed-host-runtime', 'treeseed-manager', 'treeseed-sdk', 'treeseed-cli'] as const;
const optionalCorePackages = ['treeseed-edge'] as const;

export function packageFromTrack(name: string, track: 'stable' | 'development') {
	if (!/^[a-z0-9][a-z0-9+.-]*$/u.test(name)) throw new Error('APT package name is invalid.');
	return `${name}/${track}`;
}

export function aptPreferencesForTrack(track: 'stable' | 'development') {
	const other = track === 'stable' ? 'development' : 'stable';
	return `Package: treeseed-*\nPin: release o=TreeSeed Deployment,a=${track}\nPin-Priority: 1001\n\nPackage: treeseed-*\nPin: release o=TreeSeed Deployment,a=${other}\nPin-Priority: 100\n`;
}

export function catalogPackagesForTrack(track: 'stable' | 'development') {
	const packages = [packageFromTrack('treeseed-release-catalog', track)];
	if (track === 'development') packages.push(packageFromTrack('treeseed-release-catalog-development', track));
	return packages;
}

function installedCoreVersions() {
	return Object.fromEntries([...requiredCorePackages, ...optionalCorePackages].map((name) => {
		try { return [name, execFileSync('/usr/bin/dpkg-query', ['--show', '--showformat=${Version}', name], { encoding: 'utf8' }).trim()]; }
		catch { return [name, null]; }
	}));
}

export function corePackagesForTrack(track: 'stable' | 'development', installed: Record<string, string | null>) {
	return [
		...requiredCorePackages,
		...optionalCorePackages.filter((name) => installed[name] !== null && installed[name] !== undefined),
	].map((name) => packageFromTrack(name, track));
}

export function applyPendingPackages(command: AptCommandRunner = run) {
	if (process.getuid?.() !== 0) throw new Error('APT helper must run as root.');
	const path = `${paths.managerState}/pending-packages.json`;
	const operation = supervisorOperationSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
	if (operation.operation === 'apt.install') command('/usr/bin/apt-get', [...transactionOptions, 'install', ...operation.packages]);
	else if (operation.operation === 'apt.refresh') {
		const before = operation.updateCore ? installedCoreVersions() : {};
		if (operation.updateCore) writeFileSync('/etc/apt/preferences.d/treeseed-deployment', aptPreferencesForTrack(operation.track), { encoding: 'utf8', mode: 0o644 });
		command('/usr/bin/apt-get', ['-o', 'DPkg::Lock::Timeout=600', 'update']);
		const packages = catalogPackagesForTrack(operation.track);
		if (operation.updateCore) packages.push(...corePackagesForTrack(operation.track, before));
		command('/usr/bin/apt-get', [...transactionOptions, '--target-release', operation.track, 'install', ...packages]);
		const after = operation.updateCore ? installedCoreVersions() : {};
		atomicJson(`${paths.managerState}/last-apt-result.json`, { track: operation.track, coreUpdated: operation.updateCore && JSON.stringify(before) !== JSON.stringify(after), before, after }, 0o600);
	} else throw new Error('Pending operation is not an APT transaction.');
	renameSync(path, `${paths.managerState}/last-packages.json`);
}

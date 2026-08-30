import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { paths } from '../core/paths.js';
import { atomicJson } from '../core/files.js';
import { supervisorOperationSchema } from './protocol.js';

export type AptCommandRunner = (executable: string, arguments_: readonly string[]) => void;
export type AptMetadataReader = (selector: string) => string;
const run: AptCommandRunner = (executable, arguments_) => { execFileSync(executable, [...arguments_], { stdio: 'inherit', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', DEBIAN_FRONTEND: 'noninteractive' } }); };
const inspect: AptMetadataReader = (selector) => execFileSync('/usr/bin/apt-cache', ['show', '--no-all-versions', selector], { encoding: 'utf8', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } });
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
	return track === 'development'
		? [packageFromTrack('treeseed-release-catalog-development', track)]
		: [packageFromTrack('treeseed-release-catalog', track)];
}

function packageField(metadata: string, field: string) {
	const value = metadata.match(new RegExp(`^${field}:\\s*(.+)$`, 'mu'))?.[1]?.trim();
	if (!value) throw new Error(`APT metadata is missing ${field}.`);
	return value;
}

function exactPackage(name: string, version: string) {
	if (!/^[a-z0-9][a-z0-9+.-]*$/u.test(name) || !/^[0-9A-Za-z.+:~-]+$/u.test(version)) throw new Error('APT package selection is invalid.');
	return `${name}=${version}`;
}

export function exactPackagesForRefresh(track: 'stable' | 'development', installed: Record<string, string | null>, metadata: AptMetadataReader = inspect) {
	const selected: string[] = [];
	if (track === 'development') {
		const overlay = metadata(packageFromTrack('treeseed-release-catalog-development', track));
		const overlayVersion = packageField(overlay, 'Version');
		const stableVersion = packageField(overlay, 'Depends').match(/(?:^|,\s*)treeseed-release-catalog\s*\(=\s*([^\s)]+)\s*\)/u)?.[1];
		if (!stableVersion) throw new Error('Development catalog does not declare an exact stable catalog dependency.');
		selected.push(exactPackage('treeseed-release-catalog', stableVersion), exactPackage('treeseed-release-catalog-development', overlayVersion));
	} else {
		selected.push(exactPackage('treeseed-release-catalog', packageField(metadata(packageFromTrack('treeseed-release-catalog', track)), 'Version')));
	}
	for (const selector of corePackagesForTrack(track, installed)) {
		const name = selector.slice(0, selector.indexOf('/'));
		selected.push(exactPackage(name, packageField(metadata(selector), 'Version')));
	}
	return selected;
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

/**
 * APT's archive cache is disposable download state, not artifact custody. Clear
 * it before every exact transaction so an upgrade or rollback cannot be denied
 * by the host's bounded Archives::MaxSize policy.
 */
export function installPackages(packages: readonly string[], command: AptCommandRunner = run, targetRelease?: 'stable' | 'development') {
	command('/usr/bin/apt-get', ['clean']);
	command('/usr/bin/apt-get', [...transactionOptions, ...(targetRelease ? ['--target-release', targetRelease] : []), 'install', ...packages]);
}

export function applyPendingPackages(command: AptCommandRunner = run) {
	if (process.getuid?.() !== 0) throw new Error('APT helper must run as root.');
	const path = `${paths.managerState}/pending-packages.json`;
	const operation = supervisorOperationSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
	if (operation.operation === 'apt.install') installPackages(operation.packages, command);
	else if (operation.operation === 'apt.refresh') {
		const before = operation.updateCore ? installedCoreVersions() : {};
		if (operation.updateCore) writeFileSync('/etc/apt/preferences.d/treeseed-deployment', aptPreferencesForTrack(operation.track), { encoding: 'utf8', mode: 0o644 });
		command('/usr/bin/apt-get', [
			'-o', 'DPkg::Lock::Timeout=600',
			'-o', 'Acquire::http::No-Cache=true',
			'-o', 'Acquire::https::No-Cache=true',
			'update',
		]);
		const packages = operation.updateCore
			? exactPackagesForRefresh(operation.track, before)
			: catalogPackagesForTrack(operation.track);
		installPackages(packages, command, operation.track);
		const after = operation.updateCore ? installedCoreVersions() : {};
		atomicJson(`${paths.managerState}/last-apt-result.json`, { track: operation.track, coreUpdated: operation.updateCore && JSON.stringify(before) !== JSON.stringify(after), before, after }, 0o600);
	} else throw new Error('Pending operation is not an APT transaction.');
	renameSync(path, `${paths.managerState}/last-packages.json`);
}

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { hostConfigurationSchema } from '@treeseed/sdk/deployment';
import { componentStateDirectories, componentStateRoot } from './component.js';

/** Recover active component state, not a source checkout or an assumed production root. */
export function requiredBackupState(configuration: unknown, components: unknown): string[] {
	const host = hostConfigurationSchema.parse(configuration);
	if (!Array.isArray(components)) throw new Error('Backup component inventory is missing.');
	const roots = new Set<string>();
	for (const component of components) {
		const id = component?.componentId;
		if (typeof id !== 'string' || !host.components[id]) throw new Error('Backup component identity is invalid.');
		// Provider volume recovery has its own encrypted-volume protocol.
		if (id === 'agent' && host.security) continue;
		const root = componentStateRoot(host, id);
		for (const directory of componentStateDirectories(id)) roots.add(resolve(root, directory).slice(1));
	}
	return [...roots].sort();
}

export function assertBackupStatePaths(members: string[]) {
	for (const member of members) {
		const path = `/${member}`;
		if (!existsSync(path) || !lstatSync(path).isDirectory() || realpathSync(path) !== path) throw new Error('Required component backup state is missing or has a symlink escape.');
	}
}

export function assertBackupCoverage(configuration: unknown, components: unknown, entries: string[]) {
	const names = new Set(entries.map(name => name.replace(/\/$/u, '')));
	for (const name of names) if (name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.')) throw new Error('Backup contains an unsafe archive member.');
	const required = requiredBackupState(configuration, components);
	if (required.some(member => !names.has(member))) throw new Error('Backup is incomplete: required configured component state is absent.');
	return { verified: true as const, stateDirectories: required };
}

export interface BackupEntry { path: string; type: string; linkpath?: string | undefined }
export function assertBackupEntries(configuration: unknown, components: unknown, entries: BackupEntry[]) {
	const coverage = assertBackupCoverage(configuration, components, entries.map(entry => entry.path));
	const roots = ['etc/treeseed', ...coverage.stateDirectories];
	const files = ['var/lib/treeseed/manager/current-receipt.json', 'var/lib/treeseed/manager/active-components.json'];
	const allowed = (path: string) => files.includes(path) || roots.some(root => path === root || path.startsWith(`${root}/`));
	const normalized = new Map<string, BackupEntry>();
	for (const entry of entries) {
		const path = entry.path.replace(/\/$/u, '');
		if (normalized.has(path)) throw new Error('Backup contains duplicate archive members.');
		if (!allowed(path) || !['File', 'Directory', 'SymbolicLink', 'Link'].includes(entry.type)) throw new Error('Backup contains an unowned or unsupported archive member.');
		normalized.set(path, entry);
	}
	for (const [path, entry] of normalized) {
		for (let parent = posix.dirname(path); parent !== '.'; parent = posix.dirname(parent)) {
			if (normalized.has(parent) && normalized.get(parent)!.type !== 'Directory') throw new Error('Backup member traverses an archive link.');
		}
		if (entry.type === 'Link' || entry.type === 'SymbolicLink') {
			const target = entry.linkpath ?? '';
			const resolved = entry.type === 'Link' ? posix.normalize(target) : posix.normalize(posix.join(posix.dirname(path), target));
			if (!target || posix.isAbsolute(target) || !allowed(resolved)) throw new Error('Backup link escapes managed state.');
			if (entry.type === 'Link' && normalized.get(resolved)?.type !== 'File') throw new Error('Backup hard link has no owned file target.');
		}
	}
	for (const root of coverage.stateDirectories) if (normalized.get(root)?.type !== 'Directory') throw new Error('Backup state root is not a directory.');
	return coverage;
}

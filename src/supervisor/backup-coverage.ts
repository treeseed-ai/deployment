import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
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

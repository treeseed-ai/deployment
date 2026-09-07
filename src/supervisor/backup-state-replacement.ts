import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

/** Replace owned state, not overlay it: post-snapshot database/WAL files must not survive. */
export async function withReplacedBackupState<T>(destinationRoot: string, members: string[], extract: () => Promise<T>) {
	const root = resolve(destinationRoot), moved: Array<{ path: string; quarantine: string | null }> = [];
	const targets = members.map(member => resolve(root, member));
	if (new Set(targets).size !== targets.length) throw new Error('Recovery state roots repeat.');
	for (const path of targets) {
		if (path === root || !path.startsWith(root === '/' ? '/' : `${root}${sep}`)) throw new Error('Recovery state escapes its destination.');
		for (let parent = path; parent !== dirname(parent); parent = dirname(parent)) {
			try {
				if (lstatSync(parent).isSymbolicLink() || realpathSync(parent) !== parent) throw new Error('Recovery state traverses a filesystem link.');
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
		}
		if (existsSync(path) && !lstatSync(path).isDirectory()) throw new Error('Recovery state destination is not a directory.');
		if (targets.some(other => other !== path && path.startsWith(`${other}${sep}`))) throw new Error('Recovery state roots overlap.');
	}
	let result: T;
	try {
		for (const path of targets) {
			const quarantine = existsSync(path) ? `${path}.treeseed-restore-${randomUUID()}` : null;
			if (quarantine) renameSync(path, quarantine);
			moved.push({ path, quarantine });
		}
		result = await extract();
	} catch (error) {
		for (const { path, quarantine } of moved.reverse()) {
			rmSync(path, { recursive: true, force: true });
			if (quarantine) renameSync(quarantine, path);
		}
		throw error;
	}
	// Cleanup failure must never roll back using an already removed quarantine.
	for (const { quarantine } of moved) if (quarantine) rmSync(quarantine, { recursive: true });
	return result;
}

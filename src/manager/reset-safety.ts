import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const canonicalLibraryBranches = new Set(['refs/heads/main', 'refs/heads/staging']);

function directories(path: string) {
	if (!existsSync(path)) return [];
	return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => resolve(path, entry.name));
}

async function unpublishedBranches(repositoryPath: string) {
	const { stdout } = await execFileAsync('/usr/bin/git', ['--git-dir', repositoryPath, 'for-each-ref', '--format=%(refname)', 'refs/heads']);
	return stdout.split('\n').map((line) => line.trim()).filter((ref) => ref && !canonicalLibraryBranches.has(ref));
}

/** Fail closed before reset can erase TreeDX authoring that has not reached an upstream library. */
export async function assertTreeDxResetSafe(componentDataRoot: string) {
	const treeDxRoot = resolve(componentDataRoot, 'treedx/data');
	if (!existsSync(treeDxRoot)) return { activeWorkspaces: 0, unpublishedBranches: 0 };
	const activeRoot = resolve(treeDxRoot, 'workspaces/active');
	const active = directories(activeRoot).filter((path) => statSync(path).isDirectory());
	if (active.length) throw new Error(`Host reset is blocked by ${active.length} active TreeDX workspace(s). Submit, publish, or abandon them with trsd library workspace before retrying.`);
	let unpublished = 0;
	for (const repository of directories(resolve(treeDxRoot, 'repos/bare'))) {
		try { unpublished += (await unpublishedBranches(repository)).length; }
		catch (error) { throw new Error(`Host reset could not verify TreeDX repository ${repository}; preserve the data and inspect it before retrying.`, { cause: error }); }
	}
	if (unpublished) throw new Error(`Host reset is blocked by ${unpublished} unpublished TreeDX branch(es). Publish or recover them through a governed trsd library workspace before retrying.`);
	return { activeWorkspaces: 0, unpublishedBranches: 0 };
}

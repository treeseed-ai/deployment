import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const exactCommit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
async function git(root: string, args: string[]) {
	return (await exec('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never',
		'-c', 'core.autocrlf=false', '-C', root, ...args], {
		encoding: 'utf8', timeout: 120_000, maxBuffer: 1_048_576,
		env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', GIT_CONFIG_NOSYSTEM: '1',
			GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
	})).stdout.trim();
}

/** Runs in a disposable builder guest. Never execute repository scripts or mount its filesystem on the host. */
export async function verifySourceWorkspace(root: string, commit: string) {
	if (!exactCommit.test(commit) || await git(root, ['rev-parse', 'HEAD']) !== commit) throw new Error('Source image commit mismatch.');
	await git(root, ['fsck', '--strict', '--no-reflogs']);
	if (await git(root, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Source image verification found unexpected files.');
	return { commit, tree: await git(root, ['rev-parse', 'HEAD^{tree}']), clean: true, objectClosure: true, sourceOnly: true };
}

export async function buildSourceWorkspace(input: { root: string; bundle: string; commit: string; parentCommit: string | null }) {
	if (!exactCommit.test(input.commit) || (input.parentCommit !== null && !exactCommit.test(input.parentCommit))) throw new Error('Source build requires exact commits.');
	await mkdir(input.root, { recursive: true });
	if (input.parentCommit) {
		if (await git(input.root, ['rev-parse', 'HEAD']) !== input.parentCommit) throw new Error('Workspace backing commit changed.');
		if (await git(input.root, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Workspace backing image is not clean.');
	} else {
		await git(input.root, ['init', '--quiet']);
		// ext4 bookkeeping is not project source; never copy dependency caches into READY images.
		await writeFile(resolve(input.root, '.git/info/exclude'), '/lost+found\n', { mode: 0o600 });
	}
	await git(input.root, ['bundle', 'verify', input.bundle]);
	await git(input.root, ['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--no-recurse-submodules', input.bundle, 'refs/heads/treeseed-source']);
	if (await git(input.root, ['rev-parse', 'FETCH_HEAD']) !== input.commit) throw new Error('Source bundle does not match its authorized commit.');
	if (input.parentCommit) await git(input.root, ['merge-base', '--is-ancestor', input.parentCommit, input.commit]);
	const modes = await git(input.root, ['ls-tree', '-r', input.commit]);
	if (modes.split('\n').some(line => line.startsWith('160000 '))) throw new Error('Source requires separately authorized submodule materialization.');
	await git(input.root, ['checkout', '--detach', '--force', input.commit]);
	return verifySourceWorkspace(input.root, input.commit);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const input = JSON.parse(await readFile('/run/treeseed-builder/build.json', 'utf8')) as { commit: string; parentCommit: string | null };
		const result = process.argv[2] === 'verify' ? await verifySourceWorkspace('/workspace/project', input.commit)
			: await buildSourceWorkspace({ root: '/workspace/project', bundle: '/run/treeseed-builder/source.bundle',
				commit: input.commit, parentCommit: input.parentCommit });
		await writeFile('/run/treeseed-output/source-verification.json', JSON.stringify(result));
	} catch (error) {
		await writeFile('/run/treeseed-output/source-verification.json', JSON.stringify({ failed: true,
			message: error instanceof Error ? error.message.slice(0, 1024) : 'Source build failed.' }));
		process.exitCode = 1;
	}
}

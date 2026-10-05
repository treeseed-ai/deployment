import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SandboxBrokerConfiguration } from './protocol.js';
import { WorkspaceCatalog } from './workspace-catalog.js';
import { initializeWorkspaceStorage, workspaceImagePath, workspaceStorageRoot } from './workspace-block-store.js';
import { buildWorkspaceImage } from './workspace-image-builder.js';

const exec = promisify(execFile);
/** Fixed credential-free fixture. No caller-selected paths, code, repository or identity. */
export async function qualifySourceWorkspace(configuration: SandboxBrokerConfiguration) {
	await initializeWorkspaceStorage();
	const directory = await mkdtemp(join(workspaceStorageRoot, 'source-qualification-'));
	const catalog = new WorkspaceCatalog(join(workspaceStorageRoot, 'qualification-catalog.db'));
	const sources: string[] = [], bundles: string[] = [];
	const startedAt = Date.now();
	try {
		const git = async (args: string[]) => (await exec('/usr/bin/git', ['-C', directory, ...args], {
			encoding: 'utf8', timeout: 30_000, maxBuffer: 65_536,
			env: { PATH: '/usr/bin:/bin', HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
				GIT_AUTHOR_NAME: 'Workspace Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
				GIT_COMMITTER_NAME: 'Workspace Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
		})).stdout.trim();
		await git(['init', '--quiet', '--initial-branch=treeseed-source']);
		let parentId: string | undefined, parentCommit: string | undefined;
		const results: unknown[] = [];
		for (const revision of [1, 2]) {
			await writeFile(join(directory, 'source.ts'), `export const revision = ${revision};\n`);
			await git(['add', 'source.ts']); await git(['commit', '--quiet', '-m', `Source fixture ${revision}`]);
			const commit = await git(['rev-parse', 'HEAD']), bundle = join(directory, 'source.bundle');
			await git(['bundle', 'create', bundle, 'refs/heads/treeseed-source', ...(parentCommit ? [`^${parentCommit}`] : [])]);
			const bundleDigest = `sha256:${createHash('sha256').update(await readFile(bundle)).digest('hex')}`;
			await mkdir(join(workspaceStorageRoot, 'bundles'), { recursive: true, mode: 0o700 });
			const staged = join(workspaceStorageRoot, 'bundles', `${bundleDigest.slice(7)}.bundle`);
			await copyFile(bundle, staged); await chmod(staged, 0o400); bundles.push(staged);
			const source = { controlPlaneId: 'qualification', teamId: 'qualification', projectId: 'qualification',
				repositoryId: 'qualification', commit, formatVersion: 1 as const, profile: 'source-only' as const };
			const result = await buildWorkspaceImage(configuration, catalog, { source, bundleDigest, ...(parentId ? { parentId } : {}), virtualBytes: 134_217_728 });
			sources.push(result.imageId); results.push(result);
			const replay = await buildWorkspaceImage(configuration, catalog, { source, bundleDigest, ...(parentId ? { parentId } : {}), virtualBytes: 134_217_728 });
			if (!replay.noop) throw new Error('Source workspace replay was not noop.');
			parentId = result.imageId; parentCommit = commit;
		}
		return { schemaVersion: 'treeseed.source-workspace-qualification/v1', results, incrementalHistory: true,
			independentGuestVerification: true, repeatedNoop: true, hostFilesystemMounts: 0, elapsedMs: Date.now() - startedAt };
	} finally {
		// Only the successfully published, unleased qualification images are eligible for removal.
		for (const id of sources.reverse()) if (catalog.claimDeletion(id)) {
			await rm(workspaceImagePath(id)); catalog.finishDeletion(id);
		}
		catalog.close();
		for (const path of bundles) await rm(path, { force: true });
		await rm(directory, { recursive: true, force: true });
	}
}

import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceWorkspaceResponse } from '@treeseed/sdk/capacity-provider/sandbox';
import { runSourceGit, type SourceGitCredential } from './source-git-transport.js';
import { workspaceStorageRoot } from './workspace-block-store.js';
import { simulationSourceRepository } from './simulation-source-repository.js';

const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/**
 * Publish only the independently verified commit. The temporary bundle is an
 * internal verifier handoff and is never a control-plane record or result.
 */
export async function publishVerifiedSourceBranch(input: {
	assignmentId: string;
	attempt: number;
	commit: string;
	bundlePath: string;
	response: SourceWorkspaceResponse;
	credential?: SourceGitCredential;
}) {
	if (!commitPattern.test(input.commit)) throw new Error('Invalid verified source commit.');
	const branch = input.response.authorization.publicationRef;
	if (!branch) throw new Error('Source publication omitted its exact destination ref.');
	const directory = join(workspaceStorageRoot, 'publications', randomUUID());
	const repository = join(directory, 'repository.git');
	await mkdir(repository, { recursive: true, mode: 0o700 });
	try {
		await runSourceGit(repository, ['init', '--bare', '--template=']);
		await runSourceGit(repository, ['bundle', 'unbundle', input.bundlePath]);
		if (await runSourceGit(repository, ['rev-parse', '--verify', `${input.commit}^{commit}`]) !== input.commit) {
			throw new Error('Verified source publication changed commit identity.');
		}
		await runSourceGit(repository, ['fsck', '--strict', '--no-reflogs', input.commit]);
		const remoteRef = `refs/heads/${branch}`;
		if (input.response.authorization.publication === 'simulation-branch') {
			if (input.credential) throw new Error('Simulation publication received a forbidden upstream credential.');
			const simulations = join(workspaceStorageRoot, 'simulations');
			const localRepository = simulationSourceRepository(workspaceStorageRoot, input.response.authorization.source);
			await mkdir(simulations, { recursive: true, mode: 0o700 });
			await mkdir(localRepository, { recursive: true, mode: 0o700 });
			await runSourceGit(localRepository, ['init', '--bare', '--template=']);
			await runSourceGit(localRepository, ['bundle', 'unbundle', input.bundlePath]);
			const existing = await runSourceGit(localRepository, ['for-each-ref', '--format=%(objectname)', remoteRef]);
			if (existing && existing !== input.commit) throw new Error('Simulation branch already identifies another commit.');
			if (!existing) await runSourceGit(localRepository, ['update-ref', remoteRef, input.commit, '0'.repeat(40)]);
			if (await runSourceGit(localRepository, ['rev-parse', '--verify', `${remoteRef}^{commit}`]) !== input.commit) {
				throw new Error('Simulation branch authoritative read-back failed.');
			}
		} else {
			if (!input.credential) throw new Error('Upstream publication requires its sealed credential.');
			const existing = await runSourceGit(repository, ['ls-remote', '--heads', input.response.repository.cloneUrl, remoteRef], input.credential);
			if (existing) {
				const [remoteCommit, remoteName, extra] = existing.split(/\s+/u);
				if (extra || remoteName !== remoteRef || remoteCommit !== input.commit) throw new Error('Assignment branch already identifies another commit.');
			} else {
			await runSourceGit(repository, ['push', '--no-verify', input.response.repository.cloneUrl, `${input.commit}:${remoteRef}`], input.credential);
			const readBack = await runSourceGit(repository, ['ls-remote', '--heads', input.response.repository.cloneUrl, remoteRef], input.credential);
			if (readBack !== `${input.commit}\t${remoteRef}`) throw new Error('Assignment branch authoritative read-back failed.');
			}
		}
		return { kind: 'git' as const, repository: `${input.response.repository.owner}/${input.response.repository.name}`, commit: input.commit, branch };
	} finally {
		if (input.credential) { input.credential.token = ''; input.credential.username = ''; }
		await rm(directory, { recursive: true, force: true });
	}
}

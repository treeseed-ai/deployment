import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { vi } from 'vitest';
import { publicationFixture } from './publication-fixture.js';
import { verifySourceCandidate } from '../../../src/sandbox/workspace-candidate-guest.js';
import { SourcePublicationJob, type SourcePublicationOperations } from '../../../src/sandbox/source-publication-job.js';
import { simulationSourceRepository } from '../../../src/sandbox/simulation-source-repository.js';
import { publishVerifiedSourceBranch } from '../../../src/sandbox/source-branch-publication.js';

const storage = vi.hoisted(() => ({ root: '' }));
// Only the fixed provider-storage path is redirected; publisher, Git, authorization and catalog are actual.
vi.mock('../../../src/sandbox/workspace-block-store.js', async importOriginal => ({
	...await importOriginal<typeof import('../../../src/sandbox/workspace-block-store.js')>(),
	get workspaceStorageRoot() { return storage.root; },
}));

/** Actual catalog/controller/job/verifier/publisher/Git; root path, disk and VM receipts are controlled inputs. */
export async function nativePublicationFixture() {
	const directory = await mkdtemp(join(tmpdir(), 'deployment-publication-'));
	let source: Awaited<ReturnType<typeof publicationFixture>> | undefined, readback: DatabaseSync | undefined;
	try {
		const root = join(directory, 'project'); await mkdir(root); storage.root = directory;
		const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
				GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim();
		git(root, 'init', '--quiet', '-b', 'fixture-base'); await writeFile(join(root, 'code.ts'), 'export const value = 1;\n');
		git(root, 'add', '.'); git(root, 'commit', '--quiet', '-m', 'base'); const base = git(root, 'rev-parse', 'HEAD');
		await writeFile(join(root, 'code.ts'), 'export const value = 2;\n'); git(root, 'add', '.'); git(root, 'commit', '--quiet', '-m', 'candidate');
		const commit = git(root, 'rev-parse', 'HEAD');
		const catalogPath = join(directory, 'catalog.db'), f = await publicationFixture(base, catalogPath); source = f;
		const remote = simulationSourceRepository(directory, f.response.authorization.source);
		readback = new DatabaseSync(catalogPath, { readOnly: true }); const db = readback;
		let response = structuredClone(f.response), interrupted = false, verified = 0, published = 0;
		const journals: Record<string, unknown>[] = [];
		const operations: SourcePublicationOperations = { now: () => f.now,
			current: () => { const current = f.source.attachment(); f.catalog.assertCandidateAuthority(current.leaseId, current.authorization.id, f.now); return current; },
			detachExecution: async () => undefined, journal: async value => { journals.push(structuredClone(value)); },
			verify: async input => {
				const bundlePath = join(directory, `candidate-${verified++}.bundle`);
				const verification = await verifySourceCandidate({ root, baseCommit: input.baseCommit,
					additionalCommits: input.additionalCommits, commit: input.commit, maxBytes: input.maxBytes, output: bundlePath, scratch: join(directory, 'scratch') });
				return { verification, bundlePath, digest: `sha256:${createHash('sha256').update(await readFile(bundlePath)).digest('hex')}`, verifierStopped: true };
			}, publish: async bundlePath => {
				const authority = f.source.publicationCredential(response), branch = authority.response.authorization.publicationRef;
				if (!branch) throw new Error('Fixture requires parsed publication destination');
				if (interrupted) throw new Error('isolated publication interruption');
				const reference = await publishVerifiedSourceBranch({ assignmentId: f.owner.assignmentId, attempt: f.owner.attempt,
					commit, bundlePath, response: authority.response });
				published++;
				return reference;
			} };
		return { f, base, commit, remote, root, git, journals,
			set(value: typeof response) { response = value; }, interrupt(value: boolean) { interrupted = value; },
			counts: () => ({ verified, published }), start: (stopped = true) => new SourcePublicationJob(f.owner, commit, 1_048_576, stopped, operations),
			snapshot: () => ({ images: db.prepare('SELECT * FROM workspace_images ORDER BY id').all(), leases: db.prepare('SELECT * FROM workspace_leases ORDER BY id').all() }),
			refs: () => existsSync(remote) ? git(remote, 'for-each-ref', '--format=%(objectname) %(refname)') : '',
			async close() { db.close(); f.close(); await rm(directory, { recursive: true, force: true }); } };
	} catch (error) { readback?.close(); source?.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}

import { expect, vi } from 'vitest';
import { sourceWorkspaceResponseSchema } from '@treeseed/sdk/capacity-provider/sandbox';
import { AssignmentSource, type AssignmentSourceOperations } from '../../../src/sandbox/assignment-source.js';
import { WorkspaceCatalog } from '../../../src/sandbox/workspace-catalog.js';

/** Parsed trusted-manager inputs, not authenticated API policy or a physical disk receipt. */
export async function publicationFixture(base = 'a'.repeat(40), catalogPath = ':memory:') {
	const now = new Date('2026-10-03T00:00:00.000Z');
	const owner = { assignmentId: 'assignment', providerId: 'configured-provider', teamId: 'team', projectId: 'project', attempt: 1 };
	const response = sourceWorkspaceResponseSchema.parse({ authorization: {
		schemaVersion: 'treeseed.source-workspace-authorization/v1', id: 'grant', providerId: owner.providerId,
		assignmentId: owner.assignmentId, attempt: owner.attempt,
		source: { controlPlaneId: 'control', teamId: owner.teamId, projectId: owner.projectId,
			repositoryId: 'repository-id', commit: base, formatVersion: 1, profile: 'source-only' },
		mode: 'work', acquisition: 'simulation-local', publication: 'simulation-branch',
		publicationRef: 'simulation/campaign/workday/assignment', issuedAt: now.toISOString(),
		expiresAt: new Date(+now + 60_000).toISOString() },
		repository: { provider: 'github', owner: 'treeseed-ai', name: 'sdk', cloneUrl: 'https://github.com/treeseed-ai/sdk.git', ref: base }, credential: null });
	const catalog = new WorkspaceCatalog(catalogPath), journal: Record<string, unknown>[] = [];
	const disk = { id: 'controlled-disk', directory: '/fixture/disk', image: '/fixture/disk/work.qcow2', device: '/fixture/nbd', unit: 'fixture.service' };
	const operations: AssignmentSourceOperations = { catalog, now: () => now,
		build: async () => {
			const image = catalog.ensure(response.authorization.source), job = catalog.claimBuild(image.id);
			catalog.publish(image.id, job.jobId, { digest: `sha256:${'b'.repeat(64)}`, bytes: 4096,
				commit: base, clean: true, filesystemVerified: true, builderStopped: true });
		}, createDisk: async () => disk, attachDisk: async () => disk,
		journal: async value => { journal.push(structuredClone(value)); } };
	const source = new AssignmentSource(owner, 1_073_741_824, operations);
	try {
		source.prepare(response); await vi.waitFor(() => expect(source.status().state).toBe('ready'));
		await source.attach(response);
	} catch (error) { catalog.close(); throw error; }
	return { now, owner, response, catalog, journal, source, operations, close: () => catalog.close() };
}

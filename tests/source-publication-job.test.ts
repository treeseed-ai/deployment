import { expect, it, vi } from 'vitest';
import type { SourceWorkspaceAuthorization } from '@treeseed/sdk/capacity-provider/sandbox';
import { SourcePublicationJob, type SourcePublicationOperations } from '../src/sandbox/source-publication-job.js';

function fixture() {
	const now = new Date();
	const commit = 'b'.repeat(40);
	const authorization: SourceWorkspaceAuthorization = {
		schemaVersion: 'treeseed.source-workspace-authorization/v1', id: 'grant', providerId: 'provider',
		assignmentId: 'assignment', attempt: 1,
		source: { controlPlaneId: 'control', teamId: 'team', projectId: 'project', repositoryId: 'treeseed-ai/sdk',
			commit: 'a'.repeat(40), formatVersion: 1, profile: 'source-only' },
		mode: 'work', acquisition: 'upstream-authorized', publication: 'assignment-branch',
		publicationRef: 'treeseed/assignments/assignment/1', credentialBindingId: 'binding',
		issuedAt: now.toISOString(), expiresAt: new Date(+now + 60_000).toISOString(),
	};
	const disk = { id: 'disk', directory: '/private', image: '/private/work.qcow2', device: '/dev/nbd0', unit: 'owned.service' };
	const reference = { kind: 'git' as const, repository: 'treeseed-ai/sdk', commit, branch: 'treeseed/assignments/hash/1' };
	const operations: SourcePublicationOperations = {
		now: () => now,
		current: vi.fn(() => ({ authorization, leaseId: 'lease', disk })),
		detachExecution: vi.fn(async () => undefined),
		journal: vi.fn(async () => undefined),
		verify: vi.fn(async () => ({ verification: { baseCommit: authorization.source.commit, commit, bytes: 10,
			clean: true as const, objectClosure: true as const, ancestry: true as const, isolatedVerifier: true as const },
			bundlePath: '/private/source.bundle', digest: `sha256:${'c'.repeat(64)}`, verifierStopped: true })),
		publish: vi.fn(async () => reference),
	};
	const assignment = { providerId: 'provider', assignmentId: 'assignment', attempt: 1 };
	return { operations, reference, start: (stopped = true) => new SourcePublicationJob(assignment, commit, 4096, stopped, operations) };
}

it('tears down, independently verifies, and publishes one ordinary Git reference', async () => {
	const input = fixture();
	const job = input.start();
	await job.drain();
	expect(job.status()).toEqual({ state: 'published', reference: input.reference });
	expect(vi.mocked(input.operations.detachExecution).mock.invocationCallOrder[0])
		.toBeLessThan(vi.mocked(input.operations.verify).mock.invocationCallOrder[0]!);
	expect(vi.mocked(input.operations.verify).mock.invocationCallOrder[0])
		.toBeLessThan(vi.mocked(input.operations.publish).mock.invocationCallOrder[0]!);
});

it('retains the workspace when execution teardown or publication fails', async () => {
	const stopped = fixture();
	const stoppedJob = stopped.start(false);
	await stoppedJob.drain();
	expect(stoppedJob.status().state).toBe('retained');
	expect(stopped.operations.verify).not.toHaveBeenCalled();

	const failed = fixture();
	vi.mocked(failed.operations.publish).mockRejectedValueOnce(new Error('push failed'));
	const failedJob = failed.start();
	await failedJob.drain();
	expect(failedJob.status()).toMatchObject({ state: 'retained', failure: 'push failed' });
});

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
	const reference = { kind: 'git' as const, repository: 'treeseed-ai/sdk', commit, branch: authorization.publicationRef! };
	const operations: SourcePublicationOperations = {
		now: () => now,
		current: vi.fn(() => ({ authorization, leaseId: 'lease', disk })),
		detachExecution: vi.fn(async () => undefined),
		journal: vi.fn(async () => undefined),
		verify: vi.fn(async () => ({ verification: { baseCommit: authorization.source.commit, commit, bytes: 10,
			clean: true as const, objectClosure: true as const, ancestry: true as const, isolatedVerifier: true as const },
			bundlePath: '/private/source.bundle', digest: `sha256:${'c'.repeat(64)}`, verifierStopped: true,
			verifierId: 'sandbox-warm-01234567-89ab-4cde-8fab-0123456789ab' })),
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

it('publishes only the exact current destination and preserves supplied authority and verification bytes', async () => {
	const input = fixture(), current = input.operations.current();
	const reference = { ...input.reference, branch: current.authorization.publicationRef! };
	vi.mocked(input.operations.publish).mockResolvedValue(reference);
	const before = structuredClone({ current, reference });
	const job = input.start(); await job.drain();
	expect(job.status()).toEqual({ state: 'published', reference });
	expect(job.publishedReference()).toEqual(reference);
	expect(input.operations.verify).toHaveBeenCalledOnce();
	expect(input.operations.verify).toHaveBeenCalledWith({ disk: current.disk,
		baseCommit: current.authorization.source.commit, additionalCommits: [], commit: reference.commit, maxBytes: 4096 });
	expect(input.operations.publish).toHaveBeenCalledOnce();
	expect(input.operations.publish).toHaveBeenCalledWith('/private/source.bundle');
	expect({ current, reference }).toEqual(before);
	const published = vi.mocked(input.operations.journal).mock.calls.filter(([value]) => value.state === 'published');
	expect(published).toEqual([[{ state: 'published', assignmentId: 'assignment', attempt: 1, providerId: 'provider', reference,
		verifierId: 'sandbox-warm-01234567-89ab-4cde-8fab-0123456789ab',
		verifierStopped: true, leaseId: current.leaseId, source: current.authorization.source, commit: reference.commit,
		verification: {baseCommit: current.authorization.source.commit,commit: reference.commit,bytes: 10,clean: true,objectClosure: true,ancestry: true,isolatedVerifier: true},digest: 'sha256:'+'c'.repeat(64) }]]);
});

it('retains every changed missing or malformed destination receipt rather than announcing a published candidate', async () => {
	const branches: unknown[] = [undefined, null, '', 'main', 'simulation/foreign/workday/assignment',
		'treeseed/assignments/foreign/1', { ref: 'treeseed/assignments/assignment/1' }];
	for (const branch of branches) {
		const input = fixture(), reference = Object.assign({}, input.reference, { branch });
		const before = structuredClone(reference);
		vi.mocked(input.operations.publish).mockResolvedValue(reference);
		const job = input.start(); await job.drain();
		expect(job.status().state).toBe('retained');
		expect(job.publishedReference()).toBeUndefined();
		expect(vi.mocked(input.operations.journal).mock.calls.some(([value]) => value.state === 'published')).toBe(false);
		expect(vi.mocked(input.operations.journal).mock.calls.some(([value]) => value.state === 'retained'
			&& value.reason === 'source_publication_failed')).toBe(true);
		expect(input.operations.publish).toHaveBeenCalledOnce();
		expect(reference).toEqual(before);
	}
});

it('preserves exact native verifier ownership in the same durable publication journal instead of overwriting it with a boolean or public Git reference', async () => {
	const input = fixture(), current = input.operations.current();
	const verifierId = 'sandbox-warm-01234567-89ab-4cde-8fab-0123456789ab';
	const verification = { baseCommit: current.authorization.source.commit, commit: input.reference.commit, bytes: 10,
		clean: true as const, objectClosure: true as const, ancestry: true as const, isolatedVerifier: true as const };
	const returned = { verification, bundlePath: '/private/source.bundle', digest: `sha256:${'c'.repeat(64)}`,
		verifierStopped: true, verifierId }, held = structuredClone(returned);
	input.operations.verify = vi.fn(async () => returned);
	const reference = { ...input.reference, branch: current.authorization.publicationRef! };
	vi.mocked(input.operations.publish).mockResolvedValue(reference);
	const job = input.start(); await job.drain();
	expect(job.status()).toEqual({ state: 'published', reference });
	expect(vi.mocked(input.operations.journal).mock.calls.at(-1)?.[0]).toMatchObject({
		state: 'published', assignmentId: 'assignment', providerId: 'provider', attempt: 1,
		verifierId, verifierStopped: true, reference,
    });
	expect(vi.mocked(input.operations.journal).mock.calls.at(-1)?.[0]).not.toHaveProperty('verifierChildId');
	expect(returned).toEqual(held); expect(reference).not.toHaveProperty('verifierId');
	const original = structuredClone(vi.mocked(input.operations.journal).mock.calls);
	await job.drain(); expect(vi.mocked(input.operations.journal).mock.calls).toEqual(original);
});

it('retains the exact independent candidate verification in the final publication journal before unchanged readback and drain retry',async()=>{
 const input=fixture(),current=input.operations.current(),held=structuredClone(current),job=input.start();await job.drain();
 const verified=vi.mocked(input.operations.journal).mock.calls.map(([value])=>value).filter(value=>value.state==='verified');expect(verified).toHaveLength(1);
 const original=structuredClone(verified[0]!),published=vi.mocked(input.operations.journal).mock.calls.map(([value])=>value).filter(value=>value.state==='published');expect(published).toHaveLength(1);
 expect(published[0]).toMatchObject({leaseId:current.leaseId,source:current.authorization.source,commit:input.reference.commit,
  verification:original.verification,digest:original.digest,verifierId:original.verifierId,verifierStopped:true});
 const before=structuredClone(vi.mocked(input.operations.journal).mock.calls);expect(job.publishedReference()).toEqual(input.reference);await job.drain();expect(job.status()).toEqual({state:'published',reference:input.reference});
 expect(input.operations.verify).toHaveBeenCalledOnce();expect(input.operations.publish).toHaveBeenCalledOnce();expect(vi.mocked(input.operations.journal).mock.calls).toEqual(before);expect(verified[0]).toEqual(original);expect(current).toEqual(held);
});

it('retains already verified candidate evidence beside the original failed publication instead of replacing it with failure text alone',async()=>{
 const input=fixture(),current=input.operations.current(),held=structuredClone(current),failure=new Error('retained original publication failure');vi.mocked(input.operations.publish).mockRejectedValueOnce(failure);
 const job=input.start();await job.drain();const values=vi.mocked(input.operations.journal).mock.calls.map(([value])=>value),verified=values.filter(value=>value.state==='verified');expect(verified).toHaveLength(1);
 expect(values.at(-1)).toMatchObject({state:'retained',reason:'source_publication_failed',detail:failure.message,leaseId:current.leaseId,source:current.authorization.source,commit:input.reference.commit,
  verification:verified[0]!.verification,digest:verified[0]!.digest,verifierId:verified[0]!.verifierId,verifierStopped:true});
 const before=structuredClone(values);await job.drain();expect(job.publishedReference()).toBeUndefined();expect(job.status()).toMatchObject({state:'retained',failure:failure.message});expect(input.operations.verify).toHaveBeenCalledOnce();expect(input.operations.publish).toHaveBeenCalledOnce();expect(values).toEqual(before);expect(current).toEqual(held);
});

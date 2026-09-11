import { describe, expect, it, vi } from 'vitest';
import type { SourceWorkspaceAuthorization } from '@treeseed/sdk/capacity-provider/sandbox';
import { verifyWorkspaceCandidate, type CandidateOperations } from '../src/sandbox/workspace-candidate.js';

function fixture() {
  const now = new Date('2026-09-10T00:00:00Z');
  const authorization: SourceWorkspaceAuthorization = { schemaVersion: 'treeseed.source-workspace-authorization/v1', id: 'grant',
    providerId: 'provider', assignmentId: 'assignment', attempt: 1,
    source: { controlPlaneId: 'control', teamId: 'team', projectId: 'project', repositoryId: 'repository', commit: 'a'.repeat(40), formatVersion: 1, profile: 'source-only' },
    mode: 'work', publication: 'candidate-only', credentialBindingId: 'binding', issuedAt: now.toISOString(), expiresAt: new Date(+now + 60_000).toISOString() };
  const input = { leaseId: 'lease', authorization, disk: { id: 'disk', directory: '/private/disk', image: '/private/disk/work.qcow2', device: '/dev/nbd0', unit: 'owned.service' },
    commit: 'b'.repeat(40), maxBytes: 4096, executionStopped: true };
  const result = { verification: { baseCommit: authorization.source.commit, commit: input.commit, bytes: 1024,
    clean: true as const, objectClosure: true as const, ancestry: true as const, isolatedVerifier: true as const },
    bundlePath: '/private/disk/candidate/source.bundle', digest: `sha256:${'c'.repeat(64)}`, verifierStopped: true };
  const operations: CandidateOperations = { now: () => now, journal: vi.fn(async () => undefined), verify: vi.fn(async () => result) };
  return { input, operations, result };
}
describe('source candidate custody transition', () => {
  it('journals ownership before independent verification and never represents verification as publication', async () => {
    const { input, operations, result } = fixture();
    expect(await verifyWorkspaceCandidate(input, operations)).toEqual(result);
    expect(vi.mocked(operations.journal).mock.calls.map(([value]) => value.state)).toEqual(['verifying', 'verified']);
    expect(vi.mocked(operations.journal).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(operations.verify).mock.invocationCallOrder[0]!);
    expect(JSON.stringify(vi.mocked(operations.journal).mock.calls)).not.toMatch(/accepted|persistedAt|bundlePath/);
  });
  it.each(['analysis', 'denied', 'expired', 'running'] as const)('rejects %s before verifier admission', async mode => {
    const { input, operations } = fixture();
    if (mode === 'analysis') input.authorization.mode = 'analysis';
    if (mode === 'denied') input.authorization.publication = 'denied';
    if (mode === 'expired') input.authorization.expiresAt = input.authorization.issuedAt;
    if (mode === 'running') input.executionStopped = false;
    await expect(verifyWorkspaceCandidate(input, operations)).rejects.toThrow();
    expect(operations.verify).not.toHaveBeenCalled();
  });
  it.each(['teardown', 'commit', 'limit'] as const)('retains work after an invalid %s result', async failure => {
    const { input, operations, result } = fixture();
    if (failure === 'teardown') result.verifierStopped = false;
    if (failure === 'commit') result.verification.commit = 'd'.repeat(40);
    if (failure === 'limit') result.verification.bytes = input.maxBytes + 1;
    await expect(verifyWorkspaceCandidate(input, operations)).rejects.toThrow('verification failed');
    expect(vi.mocked(operations.journal).mock.calls.at(-1)?.[0]).toMatchObject({ state: 'retained', reason: 'candidate_verification_failed' });
  });
  it('does not leak verifier errors into the durable recovery journal', async () => {
    const { input, operations } = fixture(); operations.verify = vi.fn(async () => { throw new Error('private backend details'); });
    await expect(verifyWorkspaceCandidate(input, operations)).rejects.toThrow();
    expect(JSON.stringify(vi.mocked(operations.journal).mock.calls)).not.toContain('private backend');
  });
});

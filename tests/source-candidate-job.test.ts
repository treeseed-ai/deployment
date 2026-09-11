import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceCandidateAttestation, SourceWorkspaceAuthorization } from '@treeseed/sdk/capacity-provider/sandbox';
import { SourceCandidateJob, type CandidateJobOperations } from '../src/sandbox/source-candidate-job.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function receipt(candidate: SourceCandidateAttestation) {
  const id = `source-candidate-${createHash('sha256').update(canonical(candidate)).digest('hex')}`;
  return { schemaVersion: 'treeseed.source-candidate-receipt/v1', id, leaseId: candidate.leaseId, source: candidate.source, commit: candidate.commit,
    parentCandidateId: candidate.parentCandidateId, bundle: { artifactId: id, digest: candidate.bundle.digest, bytes: candidate.bundle.bytes },
    verification: { objectClosure: true, ancestry: true, authority: true }, persistedAt: new Date().toISOString() };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'treeseed-candidate-job-')); roots.push(root);
  const path = join(root, 'source.bundle'), bytes = Buffer.from('verified candidate bundle'); await writeFile(path, bytes, { mode: 0o400 });
  const now = new Date();
  const authorization: SourceWorkspaceAuthorization = { schemaVersion: 'treeseed.source-workspace-authorization/v1', id: 'grant', providerId: 'provider', assignmentId: 'assignment', attempt: 1,
    source: { controlPlaneId: 'control', teamId: 'team', projectId: 'project', repositoryId: 'repo', commit: 'a'.repeat(40), formatVersion: 1, profile: 'source-only' },
    mode: 'work', publication: 'candidate-only', credentialBindingId: 'binding', issuedAt: now.toISOString(), expiresAt: new Date(+now + 60000).toISOString() };
  const assignment = { providerId: 'provider', assignmentId: 'assignment', attempt: 1 }, commit = 'b'.repeat(40);
  const current = { authorization, leaseId: 'lease', disk: { id: 'disk', directory: root, image: join(root, 'work.qcow2'), device: '/dev/nbd0', unit: 'owned.service' } };
  const result = { verification: { baseCommit: authorization.source.commit, commit, bytes: bytes.length, clean: true as const, objectClosure: true as const, ancestry: true as const, isolatedVerifier: true as const },
    bundlePath: path, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, verifierStopped: true };
  const operations: CandidateJobOperations = { now: () => now, current: vi.fn(() => current), detachExecution: vi.fn(async () => undefined), journal: vi.fn(async () => undefined), verify: vi.fn(async () => result) };
  return { path, bytes, current, operations, result, start: (stopped = true) => new SourceCandidateJob(assignment, commit, null, 4096, stopped, operations) };
}
it('stops execution before verification and accepts only durable correlated API read-back', async () => {
  const f = await fixture(), job = f.start(); await job.drain();
  expect(job.status().state).toBe('ready'); expect(job.acceptedReceipt()).toBeUndefined();
  expect(vi.mocked(f.operations.detachExecution).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.operations.verify).mock.invocationCallOrder[0]!);
  expect((await job.chunk(0)).content).toBe(f.bytes.toString('base64'));
  const value = receipt(job.status().candidate!);
  await expect(job.accept({ ...value, leaseId: 'other' })).rejects.toThrow('does not match');
  const accepted = await job.accept(value); expect(job.acceptedReceipt()).toEqual(accepted);
  const writes = vi.mocked(f.operations.journal).mock.calls.length;
  expect(await job.accept(value)).toEqual(accepted); expect(vi.mocked(f.operations.journal).mock.calls.length).toBe(writes);
});
it('does not admit verification without proven execution teardown', async () => {
  const f = await fixture(), job = f.start(false); await job.drain();
  expect(job.status().state).toBe('retained'); expect(f.operations.detachExecution).not.toHaveBeenCalled(); expect(f.operations.verify).not.toHaveBeenCalled();
});
it('retains storage on uncertain verifier teardown', async () => {
  const f = await fixture(); f.result.verifierStopped = false; const job = f.start(); await job.drain();
  expect(job.status().state).toBe('retained'); await expect(job.chunk(0)).rejects.toThrow('not ready');
});
it('blocks chunk access and acceptance after authority is revoked', async () => {
  const f = await fixture(), job = f.start(); await job.drain();
  vi.mocked(f.operations.current).mockImplementation(() => { throw new Error('revoked'); });
  await expect(job.chunk(0)).rejects.toThrow('revoked'); await expect(job.accept(receipt(job.status().candidate!))).rejects.toThrow('revoked');
  expect(job.acceptedReceipt()).toBeUndefined();
});
it('rejects a changed verifier file and retains unaccepted custody', async () => {
  const f = await fixture(), job = f.start(); await job.drain(); await chmod(f.path, 0o600);
  await expect(job.chunk(0)).rejects.toThrow('immutable'); expect(job.acceptedReceipt()).toBeUndefined();
});
it('does not mark accepted if the durable journal fails', async () => {
  const f = await fixture(), job = f.start(); await job.drain();
  vi.mocked(f.operations.journal).mockRejectedValueOnce(new Error('disk full'));
  await expect(job.accept(receipt(job.status().candidate!))).rejects.toThrow('disk full'); expect(job.acceptedReceipt()).toBeUndefined();
});

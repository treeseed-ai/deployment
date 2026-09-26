import { mkdtemp, mkdir, writeFile, readFile, access, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceCatalog } from '../src/sandbox/workspace-catalog.js';
import { recoverExpiredAnalysis } from '../src/sandbox/workspace-analysis-recovery.js';
import type { SourceWorkspaceAuthorization } from '@treeseed/sdk/capacity-provider/sandbox';

const roots: string[] = [], now = new Date('2026-09-26T20:00:00Z');
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(mode: 'analysis' | 'work' = 'analysis', expiresAt = '2026-09-26T19:00:00Z') {
  const root = await mkdtemp(join(tmpdir(), 'treeseed-analysis-recovery-')); roots.push(root);
  for (const name of ['jobs', 'leases', 'results']) await mkdir(join(root, name), { mode: 0o700 });
  const catalog = new WorkspaceCatalog(join(root, 'catalog.db'));
  const source = { controlPlaneId: 'api', teamId: 'team', projectId: 'project', repositoryId: 'repo',
    commit: 'a'.repeat(40), formatVersion: 1 as const, profile: 'source-only' as const };
  const image = catalog.ensure(source), build = catalog.claimBuild(image.id);
  catalog.publish(image.id, build.jobId, { commit: source.commit, bytes: 4096, digest: `sha256:${'d'.repeat(64)}`,
    clean: true, filesystemVerified: true, builderStopped: true });
  const authority: SourceWorkspaceAuthorization = { schemaVersion: 'treeseed.source-workspace-authorization/v1',
    id: 'authority', providerId: 'provider', assignmentId: 'assignment', attempt: 1, source, mode,
    acquisition: 'upstream-authorized', publication: mode === 'work' ? 'assignment-branch' : 'denied',
    ...(mode === 'work' ? { publicationRef: 'refs/heads/assignment/test' } : {}),
    credentialBindingId: 'binding', issuedAt: '2026-09-26T18:00:00Z', expiresAt };
  const lease = catalog.lease(authority, new Date(authority.issuedAt)); catalog.close();
  const id = 'workspace-lease-11111111-1111-4111-8111-111111111111', directory = join(root, 'leases', id);
  await mkdir(directory, { mode: 0o700 }); await writeFile(join(directory, 'work.qcow2'), 'opaque guest disk', { mode: 0o600 });
  const job = { schemaVersion: 'treeseed.assignment-source-job/v1', state: 'attached', authority, leaseId: lease.id,
    owner: { assignmentId: 'assignment', providerId: 'provider', attempt: 1 }, disk: { id, directory, image: join(directory, 'work.qcow2') } };
  const journal = join(root, 'jobs', 'sandbox-test.json');
  await writeFile(journal, JSON.stringify(job), { mode: 0o600 });
  return { root, id, directory, journal, job, lease };
}
describe('expired analysis recovery under fenced guest custody', () => {
  it('durably records interruption, releases only analysis, deletes disk, and replays as noop', async () => {
    const f = await fixture(); expect(await recoverExpiredAnalysis(f.root, now)).toEqual([f.id]);
    await expect(access(f.directory)).rejects.toThrow();
    const receipt = JSON.parse(await readFile(join(f.root, 'results', 'sandbox-test-recovery.json'), 'utf8'));
    expect(receipt).toMatchObject({ status: 'interrupted', result: null, leaseId: f.lease.id, teardownVerified: true });
    const db = new DatabaseSync(join(f.root, 'catalog.db'));
    try { expect(db.prepare('SELECT state,result_artifact_id FROM workspace_leases').get()).toMatchObject({ state: 'released', result_artifact_id: 'sandbox-test-recovery.json' }); }
    finally { db.close(); }
    expect(await recoverExpiredAnalysis(f.root, now)).toEqual([]);
  });
  it('preserves work disks and current analysis authority', async () => {
    for (const f of [await fixture('work'), await fixture('analysis', '2026-09-26T21:00:00Z')]) {
      expect(await recoverExpiredAnalysis(f.root, now)).toEqual([]); await access(f.directory);
    }
  });
  it('refuses attached transport and unknown disk entries before settling', async () => {
    const f = await fixture(); await writeFile(join(f.directory, 'device.json'), '{}');
    await expect(recoverExpiredAnalysis(f.root, now)).rejects.toThrow('attached or unclassified'); await access(f.directory);
  });
  it('rejects changed owner and escaped disk path', async () => {
    const f = await fixture(); f.job.owner.assignmentId = 'other';
    await writeFile(f.journal, JSON.stringify(f.job), { mode: 0o600 });
    await expect(recoverExpiredAnalysis(f.root, now)).rejects.toThrow('does not match');
    f.job.owner.assignmentId = 'assignment'; f.job.disk.directory = tmpdir();
    await writeFile(f.journal, JSON.stringify(f.job), { mode: 0o600 });
    await expect(recoverExpiredAnalysis(f.root, now)).rejects.toThrow('escaped custody');
  });
  it('rejects journal symlinks', async () => {
    const f = await fixture(); await rm(f.journal); await symlink(join(f.directory, 'work.qcow2'), f.journal);
    await expect(recoverExpiredAnalysis(f.root, now)).rejects.toThrow('journal custody');
  });
  it('finishes deletion after a crash following durable release', async () => {
    const f = await fixture(); await recoverExpiredAnalysis(f.root, now);
    await mkdir(f.directory, { mode: 0o700 }); await writeFile(join(f.directory, 'work.qcow2'), 'retained disk', { mode: 0o600 });
    expect(await recoverExpiredAnalysis(f.root, now)).toEqual([f.id]);
  });
});

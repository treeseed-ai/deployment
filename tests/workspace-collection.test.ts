import { describe, expect, it, vi } from 'vitest';
import { WorkspaceCatalog } from '../src/sandbox/workspace-catalog.js';
import { assertCollectionIdle, assertImageCustody, collectLeafBatch } from '../src/sandbox/workspace-collection.js';
import type { SourceWorkspaceKey } from '@treeseed/sdk/capacity-provider/sandbox';

const source: SourceWorkspaceKey = { controlPlaneId: 'api', teamId: 'team', projectId: 'project', repositoryId: 'repo',
  commit: 'a'.repeat(40), formatVersion: 1, profile: 'source-only' };
function publish(catalog: WorkspaceCatalog, commit = source.commit, parent: string | null = null) {
  const id = catalog.ensure({ ...source, commit }).id, { jobId } = catalog.claimBuild(id, parent);
  catalog.publish(id, jobId, { commit, bytes: 4096, digest: `sha256:${'d'.repeat(64)}`, clean: true, filesystemVerified: true, builderStopped: true });
  return id;
}

describe('fenced source collection', () => {
  it('rejects active guests, leases, builds and preparations including invalid counts', () => {
    expect(() => assertCollectionIdle('', 0, 0, 0)).not.toThrow();
    for (const counts of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [NaN, 0, 0]]) {
      expect(() => assertCollectionIdle('', counts[0]!, counts[1]!, counts[2]!)).toThrow();
    }
    expect(() => assertCollectionIdle('warm-guest', 0, 0, 0)).toThrow();
  });
  it('rejects symlinks, hardlinks, writable images and foreign ownership', () => {
    const info = { isFile: () => true, uid: 0, nlink: 1, mode: 0o400 };
    expect(() => assertImageCustody(info)).not.toThrow();
    for (const changed of [{ isFile: () => false }, { nlink: 2 }, { uid: 1000 }, { mode: 0o600 }]) {
      expect(() => assertImageCustody({ ...info, ...changed })).toThrow();
    }
  });
  it('deletes only leaves, bounds each batch and repeats as noop', async () => {
    const catalog = new WorkspaceCatalog(':memory:');
    try {
      const parent = publish(catalog), child = publish(catalog, 'b'.repeat(40), parent), remove = vi.fn(async () => {});
      expect(await collectLeafBatch(catalog, remove, 1)).toEqual([child]);
      expect(catalog.image(parent)).toBeDefined();
      expect(await collectLeafBatch(catalog, remove)).toEqual([parent]);
      expect(await collectLeafBatch(catalog, remove)).toEqual([]);
      expect(remove.mock.calls).toHaveLength(2);
      await expect(collectLeafBatch(catalog, remove, 33)).rejects.toThrow('limit');
    } finally { catalog.close(); }
  });
  it('retains deleting metadata on filesystem failure and safely resumes it', async () => {
    const catalog = new WorkspaceCatalog(':memory:');
    try {
      const id = publish(catalog);
      await expect(collectLeafBatch(catalog, async () => { throw new Error('changed custody'); })).rejects.toThrow('custody');
      expect(catalog.image(id)?.state).toBe('deleting');
      expect(await collectLeafBatch(catalog, async () => {})).toEqual([id]);
    } finally { catalog.close(); }
  });
  it('does not unlink while a build or active/quarantined lease exists', async () => {
    const catalog = new WorkspaceCatalog(':memory:'), remove = vi.fn(async () => {});
    try {
      const id = catalog.ensure(source).id;
      const build = catalog.claimBuild(id);
      await expect(collectLeafBatch(catalog, remove)).rejects.toThrow('builds');
      catalog.publish(id, build.jobId, { commit: source.commit, bytes: 4096, digest: `sha256:${'d'.repeat(64)}`,
        clean: true, filesystemVerified: true, builderStopped: true });
      catalog.lease({ schemaVersion: 'treeseed.source-workspace-authorization/v1', id: 'authority', providerId: 'provider',
        assignmentId: 'assignment', attempt: 1, source, mode: 'analysis', publication: 'denied', credentialBindingId: 'binding',
        issuedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T01:00:00Z' }, new Date('2026-01-01T00:01:00Z'));
      await expect(collectLeafBatch(catalog, remove)).rejects.toThrow('leases');
      catalog.quarantineExpired(new Date('2026-01-01T02:00:00Z'));
      await expect(collectLeafBatch(catalog, remove)).rejects.toThrow('leases');
      expect(remove).not.toHaveBeenCalled();
    } finally { catalog.close(); }
  });
});

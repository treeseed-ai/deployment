import { describe, expect, it, vi } from 'vitest';
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceCatalog } from '../src/sandbox/workspace-catalog.js';
import { assertCollectionIdle, assertGitCollectionIdle, assertImageCustody, collectGitCacheBatch, collectLeafBatch, runFencedCollection, unfinishedJobs } from '../src/sandbox/workspace-collection.js';
import type { SourceWorkspaceKey } from '@treeseed/sdk/capacity-provider/sandbox';

const source: SourceWorkspaceKey = { controlPlaneId: 'api', teamId: 'team', projectId: 'project', repositoryId: 'repo',
  commit: 'a'.repeat(40), formatVersion: 1, profile: 'source-only' };
function publish(catalog: WorkspaceCatalog, commit = source.commit, parent: string | null = null) {
  const id = catalog.ensure({ ...source, commit }).id, { jobId } = catalog.claimBuild(id, parent);
  catalog.publish(id, jobId, { commit, bytes: 4096, digest: `sha256:${'d'.repeat(64)}`, clean: true, filesystemVerified: true, builderStopped: true });
  return id;
}

describe('fenced source collection', () => {
  const operations = () => ({ idle: vi.fn(async (_scope: 'git' | 'workspace') => {}), state: vi.fn(async () => 'active'), stop: vi.fn(async () => {}),
    start: vi.fn(async () => {}), disks: vi.fn(async (): Promise<string[]> => []), collect: vi.fn(async () => ({ removed: ['base'], remainingLeaves: 0 })) });
  it('preserves detached and unclassified overlays and restores the broker', async () => {
    const ops = operations(); ops.disks.mockResolvedValue(['unclassified']);
    expect(await runFencedCollection(ops)).toMatchObject({ removed: [], retainedDisks: ['unclassified'], reason: 'overlay_custody_retained' });
    expect(ops.idle).toHaveBeenNthCalledWith(1, 'git'); expect(ops.idle).toHaveBeenNthCalledWith(2, 'git');
    expect(ops.collect).not.toHaveBeenCalled(); expect(ops.stop).toHaveBeenCalledOnce(); expect(ops.start).toHaveBeenCalledOnce();
  });
  it('collects independently fenced Git caches even when retained overlays block QCOW2 collection', async () => {
    const ops = { ...operations(), collectGit: vi.fn(async () => ({ examinedBytes: 100, reclaimedBytes: 100, reclaimedCaches: ['a'], retained: [] })) };
    ops.disks.mockResolvedValue(['unclassified']);
    expect(await runFencedCollection(ops)).toMatchObject({ gitCache: { reclaimedBytes: 100 }, removed: [], reason: 'overlay_custody_retained' });
    expect(ops.collectGit).toHaveBeenCalledOnce(); expect(ops.collect).not.toHaveBeenCalled();
    expect(ops.idle).toHaveBeenCalledTimes(2);
  });
  it('reclaims Git caches through retained unpublished work leases without collecting image ancestry', async () => {
    const ops = operations();
    ops.idle.mockImplementation(async scope => {
      if (scope === 'git') assertGitCollectionIdle('', 0, 0);
      else assertCollectionIdle('', 46, 0, 0);
    });
    ops.disks.mockResolvedValue(['detached-unpublished-work']);
    const cache = { examinedBytes: 100, reclaimedBytes: 100, reclaimedCaches: ['a'], retained: [] };
    const withGit = { ...ops, collectGit: vi.fn(async () => cache) };
    expect(await runFencedCollection(withGit)).toMatchObject({ gitCache: cache, removed: [], retainedDisks: ['detached-unpublished-work'], reason: 'overlay_custody_retained' });
    expect(withGit.idle).toHaveBeenCalledTimes(2);
    expect(withGit.collectGit).toHaveBeenCalledOnce(); expect(withGit.collect).not.toHaveBeenCalled();
  });
  it('allows idle Git collection through an exact released analysis journal while retaining overlays', async () => {
    const ops = operations();
    ops.idle.mockImplementation(async scope => {
      if (scope === 'git') assertGitCollectionIdle('', 0, 0);
      else assertCollectionIdle('', 1, 0, 0);
    });
    ops.disks.mockResolvedValue(['unpublished-work-overlay']);
    const cache = { examinedBytes: 100, reclaimedBytes: 100, reclaimedCaches: ['a'], retained: [] };
    const withGit = { ...ops, collectGit: vi.fn(async () => cache) };
    expect(await runFencedCollection(withGit)).toMatchObject({ gitCache: cache, removed: [], retainedDisks: ['unpublished-work-overlay'] });
    expect(withGit.idle.mock.calls.map(([scope]) => scope)).toEqual(['git', 'git']);
    expect(withGit.collect).not.toHaveBeenCalled();
  });
  it('rechecks custody after stopping and restarts on changed ownership', async () => {
    const ops = operations(); ops.idle.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('new lease'));
    await expect(runFencedCollection(ops)).rejects.toThrow('new lease');
    expect(ops.collect).not.toHaveBeenCalled(); expect(ops.start).toHaveBeenCalledOnce();
  });
  it('restores service on collection failure but preserves originally stopped services', async () => {
    const ops = operations(); ops.collect.mockRejectedValue(new Error('unlink failed'));
    await expect(runFencedCollection(ops)).rejects.toThrow('unlink failed'); expect(ops.start).toHaveBeenCalledOnce();
    const stopped = operations(); stopped.state.mockResolvedValue('inactive');
    expect(await runFencedCollection(stopped)).toMatchObject({ removed: ['base'] });
    expect(stopped.start).not.toHaveBeenCalled(); expect(stopped.stop).not.toHaveBeenCalled();
  });
  it('rejects active guests, leases, builds and preparations including invalid counts', () => {
    expect(() => assertCollectionIdle('', 0, 0, 0)).not.toThrow();
    for (const counts of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [NaN, 0, 0]]) {
      expect(() => assertCollectionIdle('', counts[0]!, counts[1]!, counts[2]!)).toThrow();
    }
    expect(() => assertCollectionIdle('warm-guest', 0, 0, 0)).toThrow();
  });
  it('keeps Git eligibility strict for guests, builds, unfinished jobs and uncertain counts', () => {
    expect(() => assertGitCollectionIdle('', 0, 0)).not.toThrow();
    for (const values of [['warm-guest', 0, 0], ['', 1, 0], ['', 0, 1], ['', -1, 0], ['', NaN, 0]]) {
      expect(() => assertGitCollectionIdle(values[0] as string, values[1] as number, values[2] as number)).toThrow();
    }
  });
  it('recognizes only valid non-stopped journals bound to their released analysis lease and owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-history-'));
    const catalog = new WorkspaceCatalog(join(root, 'catalog.db'));
    try {
      const id = publish(catalog), sourceLease = catalog.lease({ schemaVersion: 'treeseed.source-workspace-authorization/v1',
        id: 'authority', providerId: 'provider', assignmentId: 'assignment', attempt: 1, source, mode: 'analysis',
        acquisition: 'upstream-authorized', publication: 'denied', credentialBindingId: 'binding',
        issuedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T01:00:00Z' }, new Date('2026-01-01T00:01:00Z'));
      const jobs = join(root, 'jobs'), diskId = `workspace-lease-${'a'.repeat(8)}-${'b'.repeat(4)}-${'c'.repeat(4)}-${'d'.repeat(4)}-${'e'.repeat(12)}`;
      await mkdir(jobs, { mode: 0o700 });
      const journal = { schemaVersion: 'treeseed.assignment-source-job/v1', state: 'attached', leaseId: sourceLease.id,
        owner: { assignmentId: 'assignment', providerId: 'provider', teamId: 'team', projectId: 'project', attempt: 1 },
        authority: { id: 'authority', assignmentId: 'assignment', providerId: 'provider', attempt: 1,
          mode: 'analysis', acquisition: 'upstream-authorized', publication: 'denied' },
        disk: { id: diskId, directory: join(root, 'leases', diskId), image: join(root, 'leases', diskId, 'work.qcow2') } };
      const path = join(jobs, 'sandbox-history.json');
      const writeJournal = async (value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
      await writeJournal(journal);
      const ownerUid = process.getuid?.() ?? 0;
      expect(await unfinishedJobs(root, ownerUid)).toBe(1);
      catalog.recordDurableResult(sourceLease.id, 'sandbox-history.json'); catalog.release(sourceLease.id, true);
      expect(await unfinishedJobs(root, ownerUid)).toBe(0);
      await writeJournal({ ...journal, owner: { ...journal.owner, providerId: 'other' } });
      expect(await unfinishedJobs(root, ownerUid)).toBe(1);
      await writeJournal({ ...journal, authority: { ...journal.authority, id: 'other' } });
      expect(await unfinishedJobs(root, ownerUid)).toBe(1);
      await writeJournal({ ...journal, disk: { ...journal.disk, image: '/tmp/unrelated.qcow2' } });
      expect(await unfinishedJobs(root, ownerUid)).toBe(1);
      await writeJournal({ ...journal, leaseId: 'unmatched' });
      expect(await unfinishedJobs(root, ownerUid)).toBe(1);
      await writeJournal({ ...journal, state: 'stopped' });
      expect(await unfinishedJobs(root, ownerUid)).toBe(0);
    } finally { catalog.close(); await rm(root, { recursive: true, force: true }); }
  });
  it('rejects symlinks, hardlinks, writable images and foreign ownership', () => {
    const info = { isFile: () => true, uid: 0, nlink: 1, mode: 0o400 };
    expect(() => assertImageCustody(info)).not.toThrow();
    for (const changed of [{ isFile: () => false }, { nlink: 2 }, { uid: 1000 }, { mode: 0o600 }]) {
      expect(() => assertImageCustody({ ...info, ...changed })).toThrow();
    }
  });
  it('reclaims only canonical inactive volume images and preserves publication products', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-collection-'));
    try {
      const id = 'a'.repeat(64), cache = join(root, 'git', id), mounted = join(cache, 'mounted');
      await mkdir(mounted, { recursive: true, mode: 0o700 }); await chmod(join(root, 'git'), 0o700); await chmod(cache, 0o700);
      await writeFile(join(cache, 'objects.ext4'), 'volume', { mode: 0o400 });
      const allocatedBytes = (await lstat(join(cache, 'objects.ext4'))).blocks * 512;
      const products = ['bundles', 'simulation-git', 'source-publication', 'results', 'candidates', 'assignments', 'images'];
      for (const name of products) { await mkdir(join(root, name)); await writeFile(join(root, name, 'retained'), name); }
      const result = await collectGitCacheBatch(root, async () => false);
      expect(result).toMatchObject({ examinedBytes: allocatedBytes, reclaimedBytes: allocatedBytes, reclaimedCaches: [id], retained: [] });
      for (const name of products) expect(await readFile(join(root, name, 'retained'), 'utf8')).toBe(name);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('retains caches with acquisition fences or loop mounts and fails on uncertain custody', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-collection-'));
    try {
      const fenceId = 'b'.repeat(64), mountId = 'c'.repeat(64), uncertainTransportId = 'f'.repeat(64);
      for (const id of [fenceId, mountId, uncertainTransportId]) {
        const cache = join(root, 'git', id); await mkdir(join(cache, 'mounted'), { recursive: true, mode: 0o700 });
        await chmod(cache, 0o700); await writeFile(join(cache, 'objects.ext4'), 'volume', { mode: 0o400 });
      }
      await mkdir(join(root, 'git', fenceId, 'acquisition.lock'), { mode: 0o700 });
      const result = await collectGitCacheBatch(root, async path => {
        if (path.includes(uncertainTransportId)) throw new Error('mount inspection unavailable');
        return path.includes(mountId);
      });
      expect(result.reclaimedBytes).toBe(0);
      expect(result.retained.map(({ reason }) => reason)).toContain('acquisition_fence_present_or_unknown');
      expect(result.retained.map(({ reason }) => reason)).toContain('cache_mount_present_or_unknown');
      expect(result.retained).toContainEqual({ cacheId: uncertainTransportId, reason: 'cache_reclamation_uncertain' });
      await expect(lstat(join(root, 'git', uncertainTransportId, 'objects.ext4'))).resolves.toBeDefined();
      await expect(lstat(join(root, 'git', uncertainTransportId, 'acquisition.lock'))).resolves.toBeDefined();
      await expect(collectGitCacheBatch(root, async () => false, 33)).rejects.toThrow('limit');
      const unsafe = join(root, 'git', 'd'.repeat(64)); await mkdir(join(unsafe, 'mounted'), { recursive: true, mode: 0o700 });
      await chmod(unsafe, 0o700); await writeFile(join(unsafe, 'objects.ext4'), 'unsafe', { mode: 0o600 });
      await expect(collectGitCacheBatch(root, async () => false)).rejects.toThrow('custody');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('holds the atomic acquisition fence through collection and retains partial deletion uncertainty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-collection-'));
    try {
      const id = 'e'.repeat(64), cache = join(root, 'git', id), mounted = join(cache, 'mounted');
      await mkdir(mounted, { recursive: true, mode: 0o700 }); await chmod(join(root, 'git'), 0o700); await chmod(cache, 0o700);
      await writeFile(join(cache, 'objects.ext4'), 'volume', { mode: 0o400 });
      await writeFile(join(root, 'git', 'unexpected'), 'preserve');
      const bytes = (await lstat(join(cache, 'objects.ext4'))).blocks * 512;
      let checks = 0, acquisitionDenied = false;
      const result = await collectGitCacheBatch(root, async () => {
        const lock = join(cache, 'acquisition.lock');
        try { await mkdir(lock); } catch (error) { acquisitionDenied = (error as NodeJS.ErrnoException).code === 'EEXIST'; }
        if (++checks === 2) await unlink(join(cache, 'objects.ext4'));
        return false;
      });
      expect(acquisitionDenied).toBe(true);
      expect(result).toMatchObject({ examinedBytes: bytes, reclaimedBytes: 0, reclaimedCaches: [] });
      expect(result.retained).toEqual(expect.arrayContaining([
        { cacheId: 'unexpected', reason: 'noncanonical_cache_entry' }, { cacheId: id, reason: 'cache_reclamation_uncertain' },
      ]));
      await expect(lstat(join(cache, 'objects.ext4'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(join(cache, 'acquisition.lock'))).resolves.toBeDefined();
    } finally { await rm(root, { recursive: true, force: true }); }
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
        assignmentId: 'assignment', attempt: 1, source, mode: 'analysis', acquisition: 'upstream-authorized', publication: 'denied', credentialBindingId: 'binding',
        issuedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T01:00:00Z' }, new Date('2026-01-01T00:01:00Z'));
      await expect(collectLeafBatch(catalog, remove)).rejects.toThrow('leases');
      catalog.quarantineExpired(new Date('2026-01-01T02:00:00Z'));
      await expect(collectLeafBatch(catalog, remove)).rejects.toThrow('leases');
      expect(remove).not.toHaveBeenCalled();
    } finally { catalog.close(); }
  });
});

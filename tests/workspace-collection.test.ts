import { describe, expect, it, vi } from 'vitest';
import { WorkspaceCatalog } from '../src/sandbox/workspace-catalog.js';
import { assertCollectionIdle, assertImageCustody, CollectionRefusal, collectLeafBatch, physicalCollectionBlockers, runFencedCollection } from '../src/sandbox/workspace-collection.js';
import type { SourceWorkspaceKey } from '@treeseed/sdk/capacity-provider/sandbox';

const source: SourceWorkspaceKey = { controlPlaneId: 'api', teamId: 'team', projectId: 'project', repositoryId: 'repo',
  commit: 'a'.repeat(40), formatVersion: 1, profile: 'source-only' };
function publish(catalog: WorkspaceCatalog, commit = source.commit, parent: string | null = null) {
  const id = catalog.ensure({ ...source, commit }).id, { jobId } = catalog.claimBuild(id, parent);
  catalog.publish(id, jobId, { commit, bytes: 4096, digest: `sha256:${'d'.repeat(64)}`, clean: true, filesystemVerified: true, builderStopped: true });
  return id;
}

describe('fenced source collection', () => {
  const physicalInventory = (overrides: Record<string, unknown> = {}) => ({ complete: true, errors: [], mountInfo: '',
    confirmation: { tasks: '', containers: '', vmProcesses: [], nbdDevices: [] }, ...overrides } as any);
  const operations = () => { const releaseFence = vi.fn(async () => {}); return { releaseFence, idle: vi.fn(async () => {}), state: vi.fn(async () => 'active'), stop: vi.fn(async () => {}),
    identity: vi.fn(async () => ({ pid: 42, cgroup: '/system.slice/treeseed-sandbox-broker.service' })),
    start: vi.fn(async () => {}), restored: vi.fn(async () => true), closed: vi.fn(async (_original: { pid: number; cgroup: string } | null) => true),
    fence: vi.fn(async () => releaseFence), disks: vi.fn(async (): Promise<string[]> => []),
    hostFilesystemMounts: vi.fn(async (): Promise<string[]> => []), collect: vi.fn(async () => ({ removed: ['base'], remainingLeaves: 0 })), finish: vi.fn(async () => {}) }; };
  it('preserves detached and unclassified overlays and restores the broker', async () => {
    const ops = operations(); ops.disks.mockResolvedValue(['unclassified']);
    expect(await runFencedCollection(ops)).toMatchObject({ removed: [], retainedDisks: ['unclassified'], reason: 'overlay_custody_retained' });
    expect(ops.idle).toHaveBeenCalledOnce();
    expect(ops.collect).not.toHaveBeenCalled(); expect(ops.stop).toHaveBeenCalledOnce(); expect(ops.start).toHaveBeenCalledOnce();
    expect(ops.fence.mock.invocationCallOrder[0]).toBeLessThan(ops.idle.mock.invocationCallOrder[0]!);
    expect(ops.releaseFence).toHaveBeenCalledOnce();
    expect(ops.closed).toHaveBeenCalledWith({ pid: 42, cgroup: '/system.slice/treeseed-sandbox-broker.service' });
  });
  it('holds the producer fence through leaf collection and queues prior-state restoration before release', async () => {
    const ops = operations();
    await expect(runFencedCollection(ops)).resolves.toMatchObject({ collected: true, removed: ['base'] });
    expect(ops.collect.mock.invocationCallOrder[0]).toBeLessThan(ops.start.mock.invocationCallOrder[0]!);
    expect(ops.collect.mock.invocationCallOrder[0]).toBeLessThan(ops.finish.mock.invocationCallOrder[0]!);
    expect(ops.finish.mock.invocationCallOrder[0]).toBeLessThan(ops.start.mock.invocationCallOrder[0]!);
    expect(ops.start.mock.invocationCallOrder[0]).toBeLessThan(ops.releaseFence.mock.invocationCallOrder[0]!);
    expect(ops.releaseFence.mock.invocationCallOrder[0]).toBeLessThan(ops.restored.mock.invocationCallOrder[0]!);
  });
  it('rechecks custody after stopping and restarts on changed ownership', async () => {
    const ops = operations(); ops.idle.mockRejectedValueOnce(new CollectionRefusal('resources_not_idle', { activeLeases: 1 }));
    await expect(runFencedCollection(ops)).resolves.toMatchObject({ collected: false, reason: 'resources_not_idle', unresolved: { activeLeases: 1 } });
    expect(ops.collect).not.toHaveBeenCalled(); expect(ops.start).toHaveBeenCalledOnce(); expect(ops.releaseFence).toHaveBeenCalledOnce();
  });
  it('restores service on collection failure but preserves originally stopped services', async () => {
    const ops = operations(); ops.collect.mockRejectedValue(new Error('unlink failed'));
    await expect(runFencedCollection(ops)).rejects.toThrow('unlink failed'); expect(ops.start).toHaveBeenCalledOnce();
    expect(ops.releaseFence).toHaveBeenCalledOnce();
    const stopped = operations(); stopped.state.mockResolvedValue('inactive');
    expect(await runFencedCollection(stopped)).toMatchObject({ removed: ['base'] });
    expect(stopped.start).not.toHaveBeenCalled(); expect(stopped.stop).not.toHaveBeenCalled();
  });
  it('refuses active or unknown containers and host mounts after admission closes, then restores prior state', async () => {
    const active = operations(); active.idle.mockRejectedValue(new CollectionRefusal('resources_not_idle', { containers: ['unknown-container'] }));
    await expect(runFencedCollection(active)).resolves.toMatchObject({ collected: false, reason: 'resources_not_idle', unresolved: { containers: ['unknown-container'] } });
    expect(active.stop).toHaveBeenCalledOnce(); expect(active.collect).not.toHaveBeenCalled(); expect(active.start).toHaveBeenCalledOnce();
    const mounted = operations(); mounted.hostFilesystemMounts.mockResolvedValue(['/var/lib/treeseed/agent/workspaces/leases/x']);
    expect(await runFencedCollection(mounted)).toMatchObject({ collected: false, reason: 'host_mount_retained', removed: [] });
    expect(mounted.collect).not.toHaveBeenCalled(); expect(mounted.start).toHaveBeenCalledOnce();
  });
  it('refuses a producer race or incomplete broker closure without collecting and releases/restores', async () => {
    const race = operations(); race.fence.mockRejectedValue(new CollectionRefusal('producer_fence_unavailable', { producerFenceAcquired: false }));
    await expect(runFencedCollection(race)).resolves.toMatchObject({ collected: false, reason: 'producer_fence_unavailable' });
    expect(race.collect).not.toHaveBeenCalled(); expect(race.start).toHaveBeenCalledOnce();
    const open = operations(); open.closed.mockResolvedValue(false);
    await expect(runFencedCollection(open)).resolves.toMatchObject({ collected: false, reason: 'broker_not_closed' });
    expect(open.collect).not.toHaveBeenCalled(); expect(open.releaseFence).toHaveBeenCalledOnce();
    expect(open.start).toHaveBeenCalledOnce();
  });
  it('rejects active guests, leases, builds and preparations including invalid counts', () => {
    expect(() => assertCollectionIdle('', 0, 0, 0)).not.toThrow();
    for (const counts of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [NaN, 0, 0], [Infinity, 0, 0]]) {
      expect(() => assertCollectionIdle('', counts[0]!, counts[1]!, counts[2]!)).toThrow();
    }
    expect(() => assertCollectionIdle('warm-guest', 0, 0, 0)).toThrow();
    expect(() => assertCollectionIdle('', 0, 0, 0, 'unknown-container')).toThrow();
  });
  it('requires complete stable task, VM, NBD and host mount inventories', () => {
    expect(physicalCollectionBlockers(physicalInventory())).toBeNull();
    const unknownContainer = physicalInventory({ confirmation: { tasks: '', containers: 'unknown', vmProcesses: [], nbdDevices: [] } });
    expect(physicalCollectionBlockers(unknownContainer)).toMatchObject({ containers: ['unknown'] });
    const vm = physicalInventory({ confirmation: { tasks: '', containers: '', vmProcesses: [{ processId: 99, name: 'sandbox-unknown' }], nbdDevices: [] } });
    expect(physicalCollectionBlockers(vm)).toMatchObject({ virtualMachines: [{ processId: 99 }] });
    const nbd = physicalInventory({ confirmation: { tasks: '', containers: '', vmProcesses: [], nbdDevices: [{ device: '/dev/nbd0', processId: 20, failure: null }] } });
    expect(physicalCollectionBlockers(nbd)).toMatchObject({ nbdDevices: [{ device: '/dev/nbd0' }] });
    expect(physicalCollectionBlockers(physicalInventory({ mountInfo: '1 0 0:1 / /var/lib/treeseed/agent/workspaces/leases/x rw - ext4 /dev/loop0 rw' }))).toMatchObject({ hostFilesystemMounts: ['/var/lib/treeseed/agent/workspaces/leases/x'] });
    expect(physicalCollectionBlockers(physicalInventory({ complete: false, errors: ['vm_inventory_unavailable'] }))).toMatchObject({ physicalInventoryComplete: false, inventoryErrors: ['vm_inventory_unavailable'] });
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
        assignmentId: 'assignment', attempt: 1, source, mode: 'analysis', acquisition: 'upstream-authorized', publication: 'denied', credentialBindingId: 'binding',
        issuedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T01:00:00Z' }, new Date('2026-01-01T00:01:00Z'));
      await expect(collectLeafBatch(catalog, remove)).rejects.toThrow('leases');
      catalog.quarantineExpired(new Date('2026-01-01T02:00:00Z'));
      await expect(collectLeafBatch(catalog, remove)).rejects.toThrow('leases');
      expect(remove).not.toHaveBeenCalled();
    } finally { catalog.close(); }
  });
});

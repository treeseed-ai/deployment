import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkspaceCatalog } from './workspace-catalog.js';
import { initializeWorkspaceStorage, workspaceImagePath, workspaceStorageRoot } from './workspace-block-store.js';
import type { SandboxBrokerConfiguration } from './protocol.js';
import { inspectSandboxInventory } from './doctor.js';

const exec = promisify(execFile);
const run = async (command: string, args: string[]) => (await exec(command, args, {
  encoding: 'utf8', timeout: 120_000, maxBuffer: 65_536, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
})).stdout.trim();

export function assertCollectionIdle(tasks: string, activeLeases: number, builds: number, unfinishedJobs: number, containers = '') {
  if (tasks.trim() || containers.trim() || [activeLeases, builds, unfinishedJobs].some(value => !Number.isSafeInteger(value) || value !== 0)) {
    throw new Error('Source collection requires no guests, containers, leases, builds, or unfinished source jobs.');
  }
}

export class CollectionRefusal extends Error {
  constructor(readonly reason: 'resources_not_idle' | 'broker_not_closed' | 'broker_transitioning' | 'producer_fence_unavailable', readonly unresolved: Record<string, unknown>) {
    super(reason);
  }
}

export function assertImageCustody(info: { isFile(): boolean; uid: number; nlink: number; mode: number }) {
  if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || (info.mode & 0o222)) throw new Error('Source image custody changed.');
}

async function privateDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o077) || await realpath(path) !== path) {
    throw new Error('Source collection directory custody changed.');
  }
}

async function entries(name: string) {
  const path = join(workspaceStorageRoot, name);
  try { await privateDirectory(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return readdir(path);
}

async function unfinishedJobs() {
  let unfinished = 0; const unresolved: string[] = [];
  for (const name of await entries('jobs')) {
    if (!/^sandbox-[a-zA-Z0-9-]{1,128}\.json$/u.test(name)) { unfinished++; unresolved.push(/^[a-zA-Z0-9_.-]{1,128}$/u.test(name) ? name : '[unknown]'); continue; }
    const path = join(workspaceStorageRoot, 'jobs', name), info = await lstat(path);
    if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || (info.mode & 0o077) || info.size > 1_048_576) {
      throw new Error('Source collection journal custody changed.');
    }
    let job: unknown;
    try { job = JSON.parse(await readFile(path, 'utf8')); } catch { unfinished++; unresolved.push(name); continue; }
    if (!job || typeof job !== 'object' || !('schemaVersion' in job) || job.schemaVersion !== 'treeseed.assignment-source-job/v1'
      || !('state' in job) || job.state !== 'stopped') { unfinished++; unresolved.push(name); }
  }
  return { count: unfinished, entries: unresolved.slice(0, 32) };
}

/** Deleting metadata survives a crash after unlink. No recursive deletion and no guest filesystem access. */
export async function collectLeafBatch(catalog: WorkspaceCatalog, remove: (id: string) => Promise<void>, limit = 32) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new Error('Invalid source collection limit.');
  const removed: string[] = [];
  for (let count = 0; count < limit; count++) {
    const snapshot = catalog.collectionState();
    assertCollectionIdle('', snapshot.activeLeases, snapshot.builds, 0);
    const leaf = snapshot.leaves[0];
    if (!leaf) break;
    if (leaf.state !== 'deleting' && !catalog.claimDeletion(leaf.id)) throw new Error('Source collection ownership changed.');
    await remove(leaf.id);
    catalog.finishDeletion(leaf.id);
    removed.push(leaf.id);
  }
  return removed;
}

interface CollectionOperations {
  idle(): Promise<void>;
  state(): Promise<string>;
  identity(): Promise<{ pid: number; cgroup: string }>;
  stop(): Promise<void>;
  start(): Promise<void>;
  restored(): Promise<boolean>;
  closed(original: { pid: number; cgroup: string } | null): Promise<boolean>;
  fence(): Promise<() => Promise<void>>;
  disks(): Promise<string[]>;
  hostFilesystemMounts(): Promise<string[]>;
  collect(): Promise<{ removed: string[]; remainingLeaves: number }>;
  finish(): Promise<void>;
}

export async function runFencedCollection(operations: CollectionOperations) {
  const state = await operations.state();
  if (!['active', 'inactive', 'failed'].includes(state)) return { collected: false, removed: [], reason: 'broker_transitioning', unresolved: { activeState: state.slice(0, 64) } };
  const original = state === 'active' ? await operations.identity() : null;
  let release: (() => Promise<void>) | undefined;
  try {
    if (state === 'active') await operations.stop();
    // systemd stop is the admission close. The broker drains only its owned idle
    // warm pool before exiting; this shared/exclusive flock also fences a racing
    // broker start until collection and the restoration request are complete.
    try { release = await operations.fence(); }
    catch (error) { if (error instanceof CollectionRefusal) return { collected: false, removed: [], reason: error.reason, unresolved: error.unresolved }; throw error; }
    if (!await operations.closed(original)) return { collected: false, removed: [], reason: 'broker_not_closed', unresolved: { originalPid: original?.pid ?? null,
      originalCgroup: original?.cgroup ?? null, processOrCgroupRemains: true } };
    try { await operations.idle(); }
    catch (error) { if (error instanceof CollectionRefusal) return { collected: false, removed: [], reason: error.reason, unresolved: error.unresolved }; throw error; }
    const retainedDisks = await operations.disks();
    const hostFilesystemMounts = await operations.hostFilesystemMounts();
    if (retainedDisks.length || hostFilesystemMounts.length) return { collected: false, removed: [], retainedDisks: retainedDisks.slice(0, 32),
      retainedDiskCount: retainedDisks.length, retainedDisksTruncated: retainedDisks.length > 32,
      hostFilesystemMounts: hostFilesystemMounts.slice(0, 64), hostFilesystemMountCount: hostFilesystemMounts.length,
      hostFilesystemMountsTruncated: hostFilesystemMounts.length > 64,
      reason: retainedDisks.length ? 'overlay_custody_retained' : 'host_mount_retained' };
    return { collected: true, ...await operations.collect(), retainedDisks: [], hostFilesystemMounts: [] };
  } finally {
    try {
      await operations.finish();
    } finally {
      try {
        // start() queues a no-blocking systemd start while the exclusive lock is
        // still held. The starting broker cannot admit requests until release.
        if (state === 'active') await operations.start();
      } finally {
        await release?.();
        if (state === 'active' && !await operations.restored()) throw new Error('Sandbox broker prior active state was not restored.');
      }
    }
  }
}

const collectionFencePath = '/run/treeseed/sandbox/workspace-cache-collection.lock';
const collectionFenceDirectory = '/run/treeseed/sandbox';

/** Acquire the exclusive side of the broker's lifetime shared flock. A timeout
 * is a refusal: an overlapping or newly started broker is never ignored. */
async function acquireCollectionFence(mode: 'shared' | 'exclusive') {
  await mkdir(collectionFenceDirectory, { recursive: true, mode: 0o750 });
  const directory = await lstat(collectionFenceDirectory);
  if (!directory.isDirectory() || directory.uid !== 0 || (directory.mode & 0o027) || await realpath(collectionFenceDirectory) !== collectionFenceDirectory) {
    throw new Error('Collection producer fence directory custody changed.');
  }
  try { const handle = await open(collectionFencePath, 'wx', 0o600); await handle.close(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const lock = await lstat(collectionFencePath);
  if (!lock.isFile() || lock.uid !== 0 || lock.nlink !== 1 || (lock.mode & 0o077) || await realpath(collectionFencePath) !== collectionFencePath) {
    throw new Error('Collection producer fence file custody changed.');
  }
  const child = spawn('/usr/bin/flock', [mode === 'exclusive' ? '--exclusive' : '--shared', '--no-fork', '--wait', '5', collectionFencePath,
    '/bin/sh', '-c', 'printf "ready\\n"; exec /bin/sleep 86400'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let ready = false;
  await new Promise<void>((resolveReady, reject) => {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (!ready && chunk.includes('ready')) { ready = true; resolveReady(); }
    });
    child.once('error', reject);
    child.once('close', () => { if (!ready) reject(new CollectionRefusal('producer_fence_unavailable', { producerFenceAcquired: false })); });
  });
  return async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Collection producer fence was lost.');
    child.kill('SIGTERM');
    await once(child, 'close');
  };
}

export async function withWorkspaceCacheProducerFence<T>(operation: () => Promise<T>): Promise<T> {
  const release = await acquireCollectionFence('shared');
  try { return await operation(); }
  finally { await release(); }
}

async function brokerIdentity() {
  const pidText = await run('/usr/bin/systemctl', ['show', 'treeseed-sandbox-broker.service', '--property=MainPID', '--value']);
  const cgroup = await run('/usr/bin/systemctl', ['show', 'treeseed-sandbox-broker.service', '--property=ControlGroup', '--value']);
  if (!/^[1-9][0-9]{0,9}$/u.test(pidText) || !/^\/system\.slice\/[a-zA-Z0-9_.@:-]+$/u.test(cgroup)) {
    throw new Error('Sandbox broker original PID or cgroup identity is unavailable.');
  }
  return { pid: Number(pidText), cgroup };
}

async function brokerCgroupEmpty(original: { pid: number; cgroup: string } | null) {
  const pid = await run('/usr/bin/systemctl', ['show', 'treeseed-sandbox-broker.service', '--property=MainPID', '--value']);
  const group = await run('/usr/bin/systemctl', ['show', 'treeseed-sandbox-broker.service', '--property=ControlGroup', '--value']);
  if (pid !== '0' || !/^\/system\.slice\/[a-zA-Z0-9_.@:-]+$/u.test(group) || (original && group !== original.cgroup)) return false;
  if (original) {
    try { await readFile(`/proc/${original.pid}/stat`, 'utf8'); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const root = `/sys/fs/cgroup${group}`;
  const pending = [root];
  try {
    while (pending.length) {
      const directory = pending.pop()!;
      if ((await readFile(join(directory, 'cgroup.procs'), 'utf8')).trim()) return false;
      for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) pending.push(join(directory, entry.name));
    }
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
}

async function workspaceMounts() {
  return managedWorkspaceMounts(await readFile('/proc/1/mountinfo', 'utf8'));
}

function managedWorkspaceMounts(mountInfo: string | null) {
  if (!mountInfo) return [];
  return [...new Set(mountInfo.split('\n').flatMap(line => {
    const target = line.split(' ')[4]?.replace(/\\(040|011|012|134)/gu, escape => ({ '\\040': ' ', '\\011': '\t', '\\012': '\n', '\\134': '\\' })[escape] ?? escape);
    return target && (target === workspaceStorageRoot || target.startsWith(`${workspaceStorageRoot}/`)) ? [target] : [];
  }))];
}

export function physicalCollectionBlockers(inventory: Awaited<ReturnType<typeof inspectSandboxInventory>>) {
  const tasks = inventory.confirmation.tasks ?? '', containers = inventory.confirmation.containers ?? '';
  const vms = inventory.confirmation.vmProcesses ?? [], nbd = inventory.confirmation.nbdDevices?.filter(device => device.processId !== null || device.failure !== null) ?? [];
  const mounts = managedWorkspaceMounts(inventory.mountInfo);
  if (inventory.complete && !tasks.trim() && !containers.trim() && !vms.length && !nbd.length && !mounts.length) return null;
  const identities = (value: string) => value.split(/\s+/u).filter(Boolean).slice(0, 32).map(item => /^[a-zA-Z0-9_.:-]{1,128}$/u.test(item) ? item : '[unknown]');
  return { tasks: identities(tasks), containers: identities(containers), virtualMachines: vms.slice(0, 32).map(({ processId, name }) => ({ processId, name })),
    nbdDevices: nbd.slice(0, 32).map(({ device, processId, failure }) => ({ device, processId, failure })), hostFilesystemMounts: mounts.slice(0, 32),
    physicalInventoryComplete: inventory.complete, inventoryErrors: inventory.errors.slice(0, 32) };
}

/** Fixed serialized operator maintenance, not a timer or an assignment-path eviction. */
export async function collectWorkspaceCache(configuration: SandboxBrokerConfiguration) {
  let catalog: WorkspaceCatalog | undefined;
  const ensureCatalog = async () => {
    if (!catalog) {
      await initializeWorkspaceStorage();
      catalog = new WorkspaceCatalog(join(workspaceStorageRoot, 'catalog.db'));
    }
    return catalog;
  };
  const broker = 'treeseed-sandbox-broker.service';
  const idle = async () => {
    const workspaceCatalog = await ensureCatalog(), snapshot = workspaceCatalog.collectionState();
    const [physical, jobs, leaseEntries, candidates, results] = await Promise.all([
      inspectSandboxInventory(configuration), unfinishedJobs(), entries('leases'), entries('candidates'), entries('results'),
    ]);
    const tasks = physical.confirmation.tasks ?? '', containers = physical.confirmation.containers ?? '';
    const physicalBlockers = physicalCollectionBlockers(physical);
    try {
      assertCollectionIdle(tasks, snapshot.activeLeases, snapshot.builds, jobs.count, containers);
      if (physicalBlockers) throw new Error('Physical sandbox inventory is unresolved.');
    } catch {
      throw new CollectionRefusal('resources_not_idle', { ...(physicalBlockers ?? { tasks: [], containers: [] }), activeLeases: snapshot.activeLeases,
        retainedOverlayEntryCount: leaseEntries.length, retainedOverlayEntries: leaseEntries.slice(0, 32), builds: snapshot.builds,
        unfinishedSourceJobs: jobs.entries, retainedCandidateCount: candidates.length, retainedCandidates: candidates.slice(0, 32),
        retainedResultCount: results.length, retainedResults: results.slice(0, 32),
        remainingWorkspaceLeaves: { entries: snapshot.leaves, boundedBatchLimit: 32, mayBeTruncated: snapshot.leaves.length === 32 } });
    }
  };
  return await runFencedCollection({ idle,
      state: () => run('/usr/bin/systemctl', ['show', broker, '--property=ActiveState', '--value']),
      identity: brokerIdentity,
      stop: async () => { await run('/usr/bin/systemctl', ['stop', broker]); },
      start: async () => { await run('/usr/bin/systemctl', ['start', '--no-block', broker]); },
      restored: async () => {
        for (let attempt = 0; attempt < 120; attempt++) {
          if (await run('/usr/bin/systemctl', ['show', broker, '--property=ActiveState', '--value']) === 'active') return true;
          await delay(250);
        }
        return false;
      },
      closed: brokerCgroupEmpty,
      fence: () => acquireCollectionFence('exclusive'),
      // Even a detached unclassified disk may contain work or reference a base: preserve all ancestry.
      disks: async () => [...(await entries('leases')).map(name => `lease:${name}`), ...(await entries('devices')).map(name => `device:${name}`)],
      hostFilesystemMounts: workspaceMounts, collect: async () => {
    const workspaceCatalog = await ensureCatalog();
    await privateDirectory(join(workspaceStorageRoot, 'images'));
    const removed = await collectLeafBatch(workspaceCatalog, async id => {
      const path = workspaceImagePath(id);
      try {
        const info = await lstat(path);
        assertImageCustody(info);
        await unlink(path);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const directory = await open(join(workspaceStorageRoot, 'images'), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    });
    return { removed, remainingLeaves: workspaceCatalog.collectionState().leaves.length };
    }, finish: async () => { catalog?.close(); catalog = undefined; } });
}

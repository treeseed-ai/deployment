import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lstat, mkdir, open, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkspaceCatalog, sourceWorkspaceId } from './workspace-catalog.js';
import { sourceWorkspaceAuthorizationSchema } from '@treeseed/sdk/capacity-provider/sandbox';
import { initializeWorkspaceStorage, workspaceImagePath, workspaceStorageRoot } from './workspace-block-store.js';
import type { SandboxBrokerConfiguration } from './protocol.js';
import { inspectSandboxInventory } from './doctor.js';
import { collectionFencePath } from '../core/paths.js';

const exec = promisify(execFile);
const brokerUnit = 'treeseed-sandbox-broker.service';
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

export function assertGitCollectionIdle(tasks: string, builds: number) {
  // The caller has already proved the broker lifetime fence and physical
  // closure. Historical source journals and leases describe retained work,
  // not users of this independent trusted-host metadata volume.
  if (tasks.trim() || !Number.isSafeInteger(builds) || builds !== 0) {
    throw new Error('Git cache collection requires no guests or builds.');
  }
}

export function assertImageCustody(info: { isFile(): boolean; uid: number; nlink: number; mode: number }) {
  if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || (info.mode & 0o222)) throw new Error('Source image custody changed.');
}

async function privateDirectory(path: string, owner = 0) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== owner || (info.mode & 0o077) || await realpath(path) !== path) {
    throw new Error('Source collection directory custody changed.');
  }
}

async function entries(name: string) {
  const path = join(workspaceStorageRoot, name);
  try { await privateDirectory(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return readdir(path);
}

interface CollectionLease {
  id: string; authorization_id: string; image_id: string; assignment_id: string; provider_id: string; attempt: number;
  mode: string; acquisition: string; publication: string; state: string;
}

/** A journal is historical only when its full owner matches released catalog authority. */
export function isReleasedAnalysisHistory(job: unknown, leases: CollectionLease[], root: string) {
  if (!job || typeof job !== 'object') return false;
  const record = job as Record<string, unknown>;
  const owner = record.owner as Record<string, unknown> | undefined;
  const disk = record.disk as Record<string, unknown> | undefined;
  const parsed = sourceWorkspaceAuthorizationSchema.safeParse(record.authority);
  if (!parsed.success) return false;
  const authority = parsed.data;
  if (record.schemaVersion !== 'treeseed.assignment-source-job/v1'
    || !['awaiting-authority', 'building', 'ready', 'attaching', 'attached', 'failed'].includes(String(record.state))
    || typeof record.leaseId !== 'string' || !owner || typeof owner !== 'object' || !disk || typeof disk !== 'object'
    || !authority || typeof authority !== 'object' || typeof owner.assignmentId !== 'string'
    || typeof owner.providerId !== 'string' || typeof owner.teamId !== 'string' || typeof owner.projectId !== 'string'
    || !Number.isSafeInteger(owner.attempt) || !/^workspace-lease-[a-f0-9-]{36}$/u.test(String(disk.id))
    || disk.directory !== join(root, 'leases', String(disk.id)) || disk.image !== join(String(disk.directory), 'work.qcow2')
    || authority.mode !== 'analysis' || authority.publication !== 'denied') return false;
  const matches = leases.filter(lease => lease.id === record.leaseId);
  if (matches.length !== 1) return false;
  const lease = matches[0]!;
  return lease.mode === 'analysis' && lease.publication === 'denied' && lease.state === 'released'
    && typeof lease.authorization_id === 'string' && lease.image_id === sourceWorkspaceId(authority.source)
    && owner.teamId === authority.source.teamId && owner.projectId === authority.source.projectId
    && authority.id === lease.authorization_id && authority.acquisition === lease.acquisition
    && typeof lease.assignment_id === 'string' && typeof lease.provider_id === 'string'
    && Number.isSafeInteger(lease.attempt) && owner.assignmentId === lease.assignment_id
    && owner.providerId === lease.provider_id && owner.attempt === lease.attempt
    && authority.assignmentId === lease.assignment_id && authority.providerId === lease.provider_id
    && authority.attempt === lease.attempt;
}

async function unfinishedJobSnapshot(root = workspaceStorageRoot, owner = 0) {
  let unfinished = 0; const unresolved: string[] = [];
  const db = new DatabaseSync(join(root, 'catalog.db'), { readOnly: true });
  let leases: CollectionLease[];
  try { leases = db.prepare('SELECT id, authorization_id, image_id, assignment_id, provider_id, attempt, mode, acquisition, publication, state FROM workspace_leases').all() as unknown as CollectionLease[]; }
  finally { db.close(); }
  let names: string[];
  try { await privateDirectory(join(root, 'jobs'), owner); names = await readdir(join(root, 'jobs')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { count: 0, entries: [] as string[] }; throw error; }
  for (const name of names) {
    if (!/^sandbox-[a-zA-Z0-9-]{1,128}\.json$/u.test(name)) { unfinished++; unresolved.push(/^[a-zA-Z0-9_.-]{1,128}$/u.test(name) ? name : '[unknown]'); continue; }
    const path = join(root, 'jobs', name), info = await lstat(path);
    if (!info.isFile() || info.uid !== owner || info.nlink !== 1 || (info.mode & 0o077) || info.size > 1_048_576) {
      throw new Error('Source collection journal custody changed.');
    }
    let job: unknown;
    try { job = JSON.parse(await readFile(path, 'utf8')); } catch { unfinished++; unresolved.push(name); continue; }
    if (!job || typeof job !== 'object' || !('schemaVersion' in job) || job.schemaVersion !== 'treeseed.assignment-source-job/v1'
      || !('state' in job) || (job.state !== 'stopped' && !isReleasedAnalysisHistory(job, leases, root))) { unfinished++; unresolved.push(name); }
  }
  return { count: unfinished, entries: unresolved.slice(0, 32) };
}

async function hostMountpoint(path: string) {
  const lines = (await readFile('/proc/self/mountinfo', 'utf8')).trim().split('\n');
  for (const line of lines) {
    const fields = line.split(' '), separator = fields.indexOf('-');
    if (fields.length < 10 || separator < 6) throw new Error('Host mount custody is uncertain.');
    const mount = fields[4]!.replace(/\\([0-7]{3})/gu, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
    if (mount === path) return true;
  }
  return false;
}

export async function unfinishedJobs(root = workspaceStorageRoot, owner = 0) { return (await unfinishedJobSnapshot(root, owner)).count; }

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

export interface GitCacheCollectionResult {
  examinedBytes: number;
  reclaimedBytes: number;
  reclaimedCaches: string[];
  retained: Array<{ cacheId: string; reason: string }>;
  retainedCount: number;
  retainedTruncated: boolean;
}

/** Reclaims only fixed, private cache volumes after the caller has fenced every source worker. */
export async function collectGitCacheBatch(root: string, isMounted: (path: string) => Promise<boolean>, limit = 32): Promise<GitCacheCollectionResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new Error('Invalid source collection limit.');
  const git = join(root, 'git');
  const result: GitCacheCollectionResult = { examinedBytes: 0, reclaimedBytes: 0, reclaimedCaches: [], retained: [], retainedCount: 0, retainedTruncated: false };
  const gitInfo = await lstat(git).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
  if (!gitInfo) return result;
  await privateDirectory(git, process.getuid?.());
  const entries = await readdir(git);
  const retain = (cacheId: string, reason: string) => {
    result.retainedCount++;
    if (result.retained.length < 32) result.retained.push({ cacheId, reason });
    else result.retainedTruncated = true;
  };
  for (const cacheId of entries) {
    if (!/^[a-f0-9]{64}$/u.test(cacheId)) {
      retain(cacheId, 'noncanonical_cache_entry');
      continue;
    }
    if (result.reclaimedCaches.length >= limit) {
      retain(cacheId, 'batch_limit');
      continue;
    }
    const cache = join(git, cacheId);
    await privateDirectory(cache, process.getuid?.());
    const cacheInfo = await lstat(cache);
    const names = await readdir(cache);
    const lock = join(cache, 'acquisition.lock');
    if (names.includes('acquisition.lock')) { retain(cacheId, 'acquisition_fence_present_or_unknown'); continue; }
    if (names.some(name => name !== 'objects.ext4' && name !== 'mounted')) {
      retain(cacheId, 'unexpected_cache_custody'); continue;
    }
    const image = join(cache, 'objects.ext4'), mount = join(cache, 'mounted');
    const imageInfo = await lstat(image).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
    if (!imageInfo) { retain(cacheId, 'cache_volume_missing'); continue; }
    // This is private mutable host Git metadata, not an immutable QCOW2 base.
    // Its owning writer creates mode0600; exclusion is established by fences
    // and absent mount/loop custody, not by pretending the file is read-only.
    if (!imageInfo.isFile() || imageInfo.uid !== process.getuid?.() || imageInfo.nlink !== 1
      || (imageInfo.mode & 0o077) || await realpath(image) !== image) throw new Error('Source cache image custody changed.');
    const allocatedBytes = imageInfo.blocks * 512;
    if (!Number.isSafeInteger(allocatedBytes)) throw new Error('Source cache image size is uncertain.');
    result.examinedBytes += allocatedBytes;
    // mkdir is the same atomic fence used by acquisition. Hold it across every
    // custody recheck and unlink so acquisition cannot recreate the image.
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') { retain(cacheId, 'acquisition_fence_present_or_unknown'); continue; }
      throw error;
    }
    let keepFence = true;
    try {
      await writeFile(join(lock, 'job.json'), JSON.stringify({ jobId: randomUUID(), pid: process.pid }), { mode: 0o600, flag: 'wx' });
      if (await isMounted(mount)) { retain(cacheId, 'cache_mount_present_or_unknown'); continue; }
      const mountInfo = await lstat(mount).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
      if (mountInfo && (!mountInfo.isDirectory() || mountInfo.uid !== process.getuid?.() || mountInfo.mode & 0o077 || await realpath(mount) !== mount)) {
        retain(cacheId, 'cache_mount_custody_uncertain'); continue;
      }
      if (mountInfo && (await readdir(mount)).length) { retain(cacheId, 'cache_mount_not_empty'); continue; }
      // Recheck mount custody immediately before unlink while holding the fence.
      if (await isMounted(mount)) { retain(cacheId, 'cache_mount_present_or_unknown'); continue; }
      const currentGit = await lstat(git), currentCache = await lstat(cache);
      if (!currentGit.isDirectory() || currentGit.dev !== gitInfo.dev || currentGit.ino !== gitInfo.ino
        || currentGit.uid !== gitInfo.uid || currentGit.mode !== gitInfo.mode || await realpath(git) !== git
        || !currentCache.isDirectory() || currentCache.dev !== cacheInfo.dev || currentCache.ino !== cacheInfo.ino
        || currentCache.uid !== cacheInfo.uid || currentCache.mode !== cacheInfo.mode || await realpath(cache) !== cache) {
        throw new Error('Source cache directory custody changed under its fence.');
      }
      const current = await lstat(image);
      if (!current.isFile() || current.dev !== imageInfo.dev || current.ino !== imageInfo.ino
        || current.uid !== imageInfo.uid || current.nlink !== 1 || current.mode !== imageInfo.mode
        || current.size !== imageInfo.size || await realpath(image) !== image) throw new Error('Source cache image custody changed under its fence.');
      await unlink(image);
      if (mountInfo) { const directory = await open(mount, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
      const directory = await open(cache, 'r'); try { await directory.sync(); } finally { await directory.close(); }
      result.reclaimedBytes += allocatedBytes;
      result.reclaimedCaches.push(cacheId);
      keepFence = false;
    } catch {
      retain(cacheId, 'cache_reclamation_uncertain');
    } finally {
      // Keep ownership on any uncertain/partial deletion; recovery validates
      // this journal and releases it only after proving the owner stopped.
      if (!keepFence) await rm(lock, { recursive: true });
    }
  }
  return result;
}

interface CollectionOperations {
  idle(scope: 'git' | 'workspace'): Promise<void>;
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
  collectGit?(): Promise<GitCacheCollectionResult>;
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
    try { await operations.idle('git'); }
    catch (error) { if (error instanceof CollectionRefusal) return { collected: false, removed: [], reason: error.reason, unresolved: error.unresolved }; throw error; }
    const gitCache = operations.collectGit ? await operations.collectGit() : undefined;
    const retainedDisks = await operations.disks();
    const hostFilesystemMounts = await operations.hostFilesystemMounts();
    if (retainedDisks.length || hostFilesystemMounts.length) return { collected: false, removed: [], ...(gitCache ? { gitCache } : {}), retainedDisks: retainedDisks.slice(0, 32),
      retainedDiskCount: retainedDisks.length, retainedDisksTruncated: retainedDisks.length > 32,
      hostFilesystemMounts: hostFilesystemMounts.slice(0, 64), hostFilesystemMountCount: hostFilesystemMounts.length,
      hostFilesystemMountsTruncated: hostFilesystemMounts.length > 64,
      reason: retainedDisks.length ? 'overlay_custody_retained' : 'host_mount_retained' };
    await operations.idle('workspace');
    return { collected: true, ...await operations.collect(), ...(gitCache ? { gitCache } : {}), retainedDisks: [], hostFilesystemMounts: [] };
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
  const pidText = await run('/usr/bin/systemctl', ['show', brokerUnit, '--property=MainPID', '--value']);
  const cgroup = await run('/usr/bin/systemctl', ['show', brokerUnit, '--property=ControlGroup', '--value']);
  if (!/^[1-9][0-9]{0,9}$/u.test(pidText) || !/^\/system\.slice\/[a-zA-Z0-9_.@:-]+$/u.test(cgroup)) {
    throw new Error('Sandbox broker original PID or cgroup identity is unavailable.');
  }
  return { pid: Number(pidText), cgroup };
}

export async function brokerCgroupEmpty(original: { pid: number; cgroup: string } | null) {
  const pid = await run('/usr/bin/systemctl', ['show', brokerUnit, '--property=MainPID', '--value']);
  const reportedGroup = await run('/usr/bin/systemctl', ['show', brokerUnit, '--property=ControlGroup', '--value']);
  // systemd clears ControlGroup when the stopped unit's cgroup disappears.
  // Inspect the original issued identity, never substitute another unit.
  let group = reportedGroup || original?.cgroup || '';
  if (!group && !original) {
    const [state, slice] = await Promise.all([
      run('/usr/bin/systemctl', ['show', brokerUnit, '--property=ActiveState', '--value']),
      run('/usr/bin/systemctl', ['show', brokerUnit, '--property=Slice', '--value']),
    ]);
    if (!['inactive', 'failed'].includes(state) || slice !== 'system.slice') return false;
    group = `/${slice}/${brokerUnit}`;
  }
  if (pid !== '0' || !/^\/system\.slice\/[a-zA-Z0-9_.@:-]+$/u.test(group) || (original && group !== original.cgroup)) return false;
  if (original) {
    try { await readFile(`/proc/${original.pid}/stat`, 'utf8'); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  await readFile('/sys/fs/cgroup/cgroup.controllers', 'utf8');
  const root = `/sys/fs/cgroup${group}`;
  const pending = [root];
  try {
    while (pending.length) {
      const directory = pending.pop()!;
      if ((await readFile(join(directory, 'cgroup.procs'), 'utf8')).trim()) return false;
      for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) pending.push(join(directory, entry.name));
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A missing descendant is incomplete evidence. Only the removed original
    // root under a still-observable cgroup filesystem establishes closure.
    await readFile('/sys/fs/cgroup/cgroup.controllers', 'utf8');
    try { await lstat(root); return false; }
    catch (missing) { if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return true; throw missing; }
  }
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
  const broker = brokerUnit;
  const idle = async (scope: 'git' | 'workspace') => {
    const workspaceCatalog = await ensureCatalog(), snapshot = workspaceCatalog.collectionState();
    const [physical, leaseEntries, candidates, results] = await Promise.all([
      inspectSandboxInventory(configuration), entries('leases'), entries('candidates'), entries('results'),
    ]);
    // Git metadata has no QCOW2 ancestry. Do not make its eligibility depend
    // on retained or undecodable historical work journals.
    const jobs = scope === 'workspace' ? await unfinishedJobSnapshot() : { count: 0, entries: [] as string[] };
    const tasks = physical.confirmation.tasks ?? '', containers = physical.confirmation.containers ?? '';
    const physicalBlockers = physicalCollectionBlockers(physical);
    try {
      if (scope === 'git') assertGitCollectionIdle(tasks, snapshot.builds);
      else assertCollectionIdle(tasks, snapshot.activeLeases, snapshot.builds, jobs.count, containers);
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
      hostFilesystemMounts: workspaceMounts,
      collectGit: async () => {
        // Loop devices are global kernel custody. Any matching backing file is retained;
        // malformed output or command failure denies collection instead of guessing.
        const output = await run('/usr/sbin/losetup', ['--list', '--json', '--output', 'BACK-FILE']);
        const parsed: unknown = JSON.parse(output);
        if (!parsed || typeof parsed !== 'object' || !('loopdevices' in parsed) || !Array.isArray(parsed.loopdevices)) throw new Error('Loop device custody is uncertain.');
        const loopFiles = parsed.loopdevices.map((entry: unknown) => {
          if (!entry || typeof entry !== 'object' || !('back-file' in entry) || typeof entry['back-file'] !== 'string') throw new Error('Loop device custody is uncertain.');
          return entry['back-file'];
        });
        return collectGitCacheBatch(workspaceStorageRoot, async path => {
          if (await hostMountpoint(path)) return true;
          const image = join(path, '..', 'objects.ext4');
          return loopFiles.includes(image);
        });
      }, collect: async () => {
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

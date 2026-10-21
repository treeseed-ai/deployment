import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { WorkspaceCatalog } from './workspace-catalog.js';
import { initializeWorkspaceStorage, workspaceImagePath, workspaceStorageRoot } from './workspace-block-store.js';
import type { SandboxBrokerConfiguration } from './protocol.js';

const exec = promisify(execFile);
const run = async (command: string, args: string[]) => (await exec(command, args, {
  encoding: 'utf8', timeout: 120_000, maxBuffer: 65_536, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
})).stdout.trim();

export function assertCollectionIdle(tasks: string, activeLeases: number, builds: number, unfinishedJobs: number) {
  if (tasks.trim() || [activeLeases, builds, unfinishedJobs].some(value => value !== 0)) {
    throw new Error('Source collection requires no guests, leases, builds, or unfinished source jobs.');
  }
}

export function assertGitCollectionIdle(tasks: string, builds: number, unfinishedJobs: number) {
  if (tasks.trim() || [builds, unfinishedJobs].some(value => !Number.isSafeInteger(value) || value !== 0)) {
    throw new Error('Git cache collection requires no guests, builds, or unfinished source jobs.');
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

async function unfinishedJobs() {
  let unfinished = 0;
  for (const name of await entries('jobs')) {
    if (!/^sandbox-[a-zA-Z0-9-]{1,128}\.json$/u.test(name)) { unfinished++; continue; }
    const path = join(workspaceStorageRoot, 'jobs', name), info = await lstat(path);
    if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || (info.mode & 0o077) || info.size > 1_048_576) {
      throw new Error('Source collection journal custody changed.');
    }
    const job: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!job || typeof job !== 'object' || !('schemaVersion' in job) || job.schemaVersion !== 'treeseed.assignment-source-job/v1'
      || !('state' in job) || job.state !== 'stopped') unfinished++;
  }
  return unfinished;
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
}

/** Reclaims only fixed, private cache volumes after the caller has fenced every source worker. */
export async function collectGitCacheBatch(root: string, isMounted: (path: string) => Promise<boolean>, limit = 32): Promise<GitCacheCollectionResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new Error('Invalid source collection limit.');
  const git = join(root, 'git');
  const result: GitCacheCollectionResult = { examinedBytes: 0, reclaimedBytes: 0, reclaimedCaches: [], retained: [] };
  const gitInfo = await lstat(git).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
  if (!gitInfo) return result;
  await privateDirectory(git, process.getuid?.());
  const entries = await readdir(git);
  for (const cacheId of entries.slice(0, limit)) {
    if (!/^[a-f0-9]{64}$/u.test(cacheId)) {
      result.retained.push({ cacheId, reason: 'noncanonical_cache_entry' });
      continue;
    }
    const cache = join(git, cacheId);
    await privateDirectory(cache, process.getuid?.());
    const names = await readdir(cache);
    const lock = join(cache, 'acquisition.lock');
    if (names.includes('acquisition.lock')) { result.retained.push({ cacheId, reason: 'acquisition_fence_present_or_unknown' }); continue; }
    if (names.some(name => name !== 'objects.ext4' && name !== 'mounted')) {
      result.retained.push({ cacheId, reason: 'unexpected_cache_custody' }); continue;
    }
    const image = join(cache, 'objects.ext4'), mount = join(cache, 'mounted');
    const imageInfo = await lstat(image).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
    if (!imageInfo) { result.retained.push({ cacheId, reason: 'cache_volume_missing' }); continue; }
    if (!imageInfo.isFile() || imageInfo.uid !== process.getuid?.() || imageInfo.nlink !== 1 || (imageInfo.mode & 0o222)
      || (imageInfo.mode & 0o077) || await realpath(image) !== image) throw new Error('Source cache image custody changed.');
    const allocatedBytes = imageInfo.blocks * 512;
    if (!Number.isSafeInteger(allocatedBytes)) throw new Error('Source cache image size is uncertain.');
    result.examinedBytes += allocatedBytes;
    // mkdir is the same atomic fence used by acquisition. Hold it across every
    // custody recheck and unlink so acquisition cannot recreate the image.
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') { result.retained.push({ cacheId, reason: 'acquisition_fence_present_or_unknown' }); continue; }
      throw error;
    }
    let keepFence = true;
    try {
      await writeFile(join(lock, 'job.json'), JSON.stringify({ jobId: randomUUID(), pid: process.pid }), { mode: 0o600, flag: 'wx' });
      if (await isMounted(mount)) { result.retained.push({ cacheId, reason: 'cache_mount_present_or_unknown' }); keepFence = false; continue; }
      const mountInfo = await lstat(mount).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
      if (mountInfo && (!mountInfo.isDirectory() || mountInfo.uid !== process.getuid?.() || mountInfo.mode & 0o077 || await realpath(mount) !== mount)) {
        result.retained.push({ cacheId, reason: 'cache_mount_custody_uncertain' }); keepFence = false; continue;
      }
      if (mountInfo && (await readdir(mount)).length) { result.retained.push({ cacheId, reason: 'cache_mount_not_empty' }); keepFence = false; continue; }
      // Recheck mount custody immediately before unlink while holding the fence.
      if (await isMounted(mount)) { result.retained.push({ cacheId, reason: 'cache_mount_present_or_unknown' }); keepFence = false; continue; }
      await unlink(image);
      if (mountInfo) { const directory = await open(mount, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
      const directory = await open(cache, 'r'); try { await directory.sync(); } finally { await directory.close(); }
      result.reclaimedBytes += allocatedBytes;
      result.reclaimedCaches.push(cacheId);
      keepFence = false;
    } catch {
      result.retained.push({ cacheId, reason: 'cache_reclamation_uncertain' });
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
  stop(): Promise<void>;
  start(): Promise<void>;
  disks(): Promise<string[]>;
  collect(): Promise<{ removed: string[]; remainingLeaves: number }>;
  collectGit?(): Promise<GitCacheCollectionResult>;
}

export async function runFencedCollection(operations: CollectionOperations) {
  await operations.idle('git');
  const state = await operations.state();
  if (!['active', 'inactive', 'failed'].includes(state)) throw new Error('Sandbox broker is transitioning.');
  try {
    if (state === 'active') await operations.stop();
    await operations.idle('git');
    const retainedDisks = await operations.disks();
    const gitCache = operations.collectGit ? await operations.collectGit() : undefined;
    if (retainedDisks.length) return { ...(gitCache ? { gitCache } : {}), removed: [], retainedDisks, reason: 'overlay_custody_retained', hostFilesystemMounts: 0 };
    await operations.idle('workspace');
    return { ...await operations.collect(), ...(gitCache ? { gitCache } : {}), retainedDisks: [], hostFilesystemMounts: 0 };
  } finally { if (state === 'active') await operations.start(); }
}

/** Fixed serialized operator maintenance, not a timer or an assignment-path eviction. */
export async function collectWorkspaceCache(configuration: SandboxBrokerConfiguration) {
  await initializeWorkspaceStorage();
  const catalog = new WorkspaceCatalog(join(workspaceStorageRoot, 'catalog.db'));
  const broker = 'treeseed-sandbox-broker.service';
  const idle = async (scope: 'git' | 'workspace') => {
    const snapshot = catalog.collectionState();
    const tasks = await run('/usr/bin/ctr', ['--address', configuration.containerdAddress,
      '--namespace', configuration.namespace, 'tasks', 'list', '--quiet']);
    const jobs = await unfinishedJobs();
    if (scope === 'git') assertGitCollectionIdle(tasks, snapshot.builds, jobs);
    else assertCollectionIdle(tasks, snapshot.activeLeases, snapshot.builds, jobs);
  };
  try {
    return await runFencedCollection({ idle,
      state: () => run('/usr/bin/systemctl', ['show', broker, '--property=ActiveState', '--value']),
      stop: async () => { await run('/usr/bin/systemctl', ['stop', broker]); },
      start: async () => { await run('/usr/bin/systemctl', ['start', broker]); },
      // Even a detached unclassified disk may contain work or reference a base: preserve all ancestry.
      disks: () => entries('leases'),
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
    await privateDirectory(join(workspaceStorageRoot, 'images'));
    const removed = await collectLeafBatch(catalog, async id => {
      const path = workspaceImagePath(id);
      try {
        const info = await lstat(path);
        assertImageCustody(info);
        await unlink(path);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const directory = await open(join(workspaceStorageRoot, 'images'), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    });
    return { removed, remainingLeaves: catalog.collectionState().leaves.length };
    } });
  } finally { catalog.close(); }
}

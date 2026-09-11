import { execFile } from 'node:child_process';
import { lstat, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
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

/** Fixed serialized operator maintenance, not a timer or an assignment-path eviction. */
export async function collectWorkspaceCache(configuration: SandboxBrokerConfiguration) {
  await initializeWorkspaceStorage();
  const catalog = new WorkspaceCatalog(join(workspaceStorageRoot, 'catalog.db'));
  const broker = 'treeseed-sandbox-broker.service';
  let restart = false;
  const idle = async () => {
    const snapshot = catalog.collectionState();
    assertCollectionIdle(await run('/usr/bin/ctr', ['--address', configuration.containerdAddress,
      '--namespace', configuration.namespace, 'tasks', 'list', '--quiet']), snapshot.activeLeases, snapshot.builds, await unfinishedJobs());
  };
  try {
    await idle();
    const state = await run('/usr/bin/systemctl', ['show', broker, '--property=ActiveState', '--value']);
    if (!['active', 'inactive', 'failed'].includes(state)) throw new Error('Sandbox broker is transitioning.');
    restart = state === 'active';
    if (restart) await run('/usr/bin/systemctl', ['stop', broker]);
    await idle();
    // Even a detached unclassified disk may contain work or reference a base: preserve all ancestry.
    const retainedDisks = await entries('leases');
    if (retainedDisks.length) return { removed: [], retainedDisks, reason: 'overlay_custody_retained', hostFilesystemMounts: 0 };
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
    return { removed, retainedDisks: [], remainingLeaves: catalog.collectionState().leaves.length, hostFilesystemMounts: 0 };
  } finally {
    catalog.close();
    if (restart) await run('/usr/bin/systemctl', ['start', broker]);
  }
}

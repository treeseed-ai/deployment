import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import type { SandboxBrokerConfiguration } from './protocol.js';
import { detachWorkspaceDisk, initializeWorkspaceStorage, workspaceStorageRoot } from './workspace-block-store.js';
import { WorkspaceCatalog } from './workspace-catalog.js';

const exec = promisify(execFile);
const run = async (command: string, args: string[]) => (await exec(command, args, {
  encoding: 'utf8', timeout: 120_000, maxBuffer: 65_536,
  env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
})).stdout.trim();

export function assertWorkspaceRecoveryIdle(tasks: string, activeLeases: number) {
  if (tasks.trim() || activeLeases !== 0) throw new Error('Workspace recovery requires no guests or active workspace leases.');
}

/** Serialized supervisor maintenance. Retains every disk, including unpublished work.
 * No guest filesystem is read or mounted, and no task is force-killed for recovery. */
export async function recoverWorkspaceBuilds(configuration: SandboxBrokerConfiguration) {
  await initializeWorkspaceStorage();
  const database = join(workspaceStorageRoot, 'catalog.db');
  const tasks = () => run('/usr/bin/ctr', ['--address', configuration.containerdAddress,
    '--namespace', configuration.namespace, 'tasks', 'list', '--quiet']);
  const inspect = () => {
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      return { active: Number(db.prepare("SELECT count(*) AS n FROM workspace_leases WHERE state!='released'").get()!.n),
        builds: db.prepare("SELECT id,job_id FROM workspace_images WHERE state='building'").all() as { id: string; job_id: string }[] };
    } finally { db.close(); }
  };
  assertWorkspaceRecoveryIdle(await tasks(), inspect().active);
  const broker = 'treeseed-sandbox-broker.service';
  const state = await run('/usr/bin/systemctl', ['show', broker, '--property=ActiveState', '--value']);
  if (!['active', 'inactive', 'failed'].includes(state)) throw new Error('Sandbox broker is transitioning.');
  try {
    if (state === 'active') await run('/usr/bin/systemctl', ['stop', broker]);
    const snapshot = inspect();
    assertWorkspaceRecoveryIdle(await tasks(), snapshot.active);
    const detached: string[] = [];
    for (const id of await readdir(join(workspaceStorageRoot, 'leases'))) {
      if (!/^workspace-lease-[a-f0-9-]{36}$/u.test(id)) continue;
      const directory = join(workspaceStorageRoot, 'leases', id), details = await lstat(directory);
      if (!details.isDirectory() || details.uid !== 0 || (details.mode & 0o077) || await realpath(directory) !== directory) {
        throw new Error('Workspace recovery directory custody changed.');
      }
      const path = join(directory, 'device.json');
      let metadata;
      try { metadata = await lstat(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (!metadata.isFile() || metadata.uid !== 0 || metadata.nlink !== 1 || metadata.size > 4096 || (metadata.mode & 0o077)) {
        throw new Error('Workspace recovery device custody changed.');
      }
      const device = JSON.parse(await readFile(path, 'utf8')) as { id: string; device: string };
      if (device.id !== id) throw new Error('Workspace recovery identity changed.');
      await detachWorkspaceDisk({ id, directory, device: device.device, image: join(directory, 'work.qcow2'), unit: `treeseed-${id}.service` }, true);
      detached.push(id);
    }
    const catalog = new WorkspaceCatalog(database);
    try {
      for (const build of snapshot.builds) {
        if (!catalog.failBuild(build.id, build.job_id)) throw new Error('Workspace recovery build ownership changed.');
      }
    } finally { catalog.close(); }
    return { recoveredBuilds: snapshot.builds.map(build => build.id), detached, diskContentsRetained: true, hostFilesystemMounts: 0 };
  } finally {
    if (state === 'active') await run('/usr/bin/systemctl', ['start', broker]);
  }
}

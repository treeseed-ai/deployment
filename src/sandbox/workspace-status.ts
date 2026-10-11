import { DatabaseSync } from 'node:sqlite';
import { closeSync, constants, fstatSync, openSync, readlinkSync, readSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceStorageRoot } from './workspace-block-store.js';
import { inspectManagedDirectory, owningHostStat } from './directory-inspection.js';

type Disk = { id: string; type: 'directory' | 'file' | 'symlink' | 'other'; bytes: number | null;
 device: { id: string; device: string } | null };
const maximumDeviceIdentityBytes = 4096;

function optionalFile(path: string) {
 try {
  const stat = owningHostStat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path
   || !Number.isSafeInteger(stat.size) || stat.size < 0) throw new Error('Owning metadata is redirected or malformed.');
  return stat;
 } catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
  throw error;
 }
}

/** Read only bounded device identity, never the encrypted disk or guest contents. */
function deviceIdentity(path: string, id: string) {
 const stat = optionalFile(path); if (!stat) return null;
 if (stat.size > maximumDeviceIdentityBytes) throw new Error('Owning device identity exceeds its bounded metadata size.');
 const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  const held = fstatSync(fd);
  if (!held.isFile() || held.dev !== stat.dev || held.ino !== stat.ino || held.size !== stat.size) throw new Error('Owning device identity changed.');
  const bytes = Buffer.alloc(maximumDeviceIdentityBytes + 1), length = readSync(fd, bytes, 0, bytes.length, 0);
  const final = owningHostStat(path);
  if (held.dev !== stat.dev || held.ino !== stat.ino || length !== stat.size || final.size !== stat.size
   || final.dev !== stat.dev || final.ino !== stat.ino || final.mtimeMs !== stat.mtimeMs) throw new Error('Owning device identity changed.');
  const value: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Owning device identity is malformed.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'device,id' || record.id !== id
   || typeof record.device !== 'string' || !/^\/dev\/nbd\d+$/u.test(record.device)) throw new Error('Owning device identity is malformed.');
  return { id, device: record.device };
 } finally { closeSync(fd); }
}

/** Fixed read-only observations, independent of catalog availability. No runtime
 * is constructed, disk content read, or catalog/directory repaired here. */
export function workspaceStatus() {
 const startedAt = new Date().toISOString(), errors = new Set<string>();
 let mountNamespace: string | null = null, rootVerified = false;
 try {
  mountNamespace = readlinkSync('/proc/1/ns/mnt');
  if (!/^mnt:\[\d+\]$/u.test(mountNamespace)) throw new Error();
  rootVerified = realpathSync(workspaceStorageRoot) === workspaceStorageRoot && owningHostStat(workspaceStorageRoot).isDirectory();
  if (!rootVerified) throw new Error();
 } catch { errors.add('workspace_lease_inventory_unavailable'); }
 const observe = () => {
  const directory = { rootPresent: null as boolean | null,
   entries: [] as Array<{ name: string; type: Disk['type'] }> };
  const disks: Disk[] = [];
  try {
   if (!rootVerified) throw new Error();
   inspectManagedDirectory(join(workspaceStorageRoot, 'leases'), directory);
   for (const entry of directory.entries) {
    const disk: Disk = { id: entry.name, type: entry.type, bytes: null, device: null }; disks.push(disk);
    try {
     if (entry.type !== 'directory' || !/^workspace-lease-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(entry.name)) throw new Error();
     const root = join(workspaceStorageRoot, 'leases', entry.name);
     if (realpathSync(root) !== root) throw new Error();
     disk.bytes = optionalFile(join(root, 'work.qcow2'))?.size ?? null;
     disk.device = deviceIdentity(join(root, 'device.json'), entry.name);
    } catch { errors.add('workspace_lease_metadata_unavailable'); }
   }
  } catch { errors.add('workspace_lease_inventory_unavailable'); }
  return { leaseDirectoryPresent: directory.rootPresent, disks };
 };
 const observed = observe();
 let initialized = false, images: unknown[] | null = null, leases: unknown[] | null = null;
 try {
  if (!rootVerified) throw new Error();
  const database = join(workspaceStorageRoot, 'catalog.db'), stat = owningHostStat(database); initialized = true;
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(database) !== database) throw new Error();
  const db = new DatabaseSync(database, { readOnly: true });
  try {
   db.exec('BEGIN');
   const heldImages = db.prepare('SELECT id,state,job_id,bytes,parent_id FROM workspace_images ORDER BY id').all();
   const heldLeases = db.prepare('SELECT id,image_id,assignment_id,attempt,mode,state,result_artifact_id FROM workspace_leases ORDER BY id').all();
   db.exec('COMMIT'); images = heldImages; leases = heldLeases;
  } finally { db.close(); }
 } catch { errors.add('workspace_catalog_unavailable'); }
 const confirmation = observe();
 if (JSON.stringify(observed) !== JSON.stringify(confirmation)) errors.add('workspace_inventory_changed');
 let confirmedNamespace: string | null = null;
 try {
  confirmedNamespace = readlinkSync('/proc/1/ns/mnt');
  if (confirmedNamespace !== mountNamespace) errors.add('workspace_inventory_changed');
 } catch { errors.add('workspace_lease_inventory_unavailable'); }
 return { startedAt, completedAt: new Date().toISOString(), complete: errors.size === 0,
  scope: { storageRoot: workspaceStorageRoot, mountNamespace }, initialized, images, leases,
  ...observed, confirmation: { ...confirmation, mountNamespace: confirmedNamespace }, errors: [...errors] };
}

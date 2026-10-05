import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceStorageRoot } from './workspace-block-store.js';

/** Read-only owned metadata, never a credential or guest filesystem read. */
export function workspaceStatus() {
  const database = join(workspaceStorageRoot,'catalog.db');
  if (!existsSync(database)) return { initialized: false };
  const db = new DatabaseSync(database,{readOnly:true});
  try {
    const directory = join(workspaceStorageRoot,'leases');
    const disks = existsSync(directory) ? readdirSync(directory).filter(name => /^workspace-lease-[a-f0-9-]{36}$/u.test(name)).map(id => {
      const deviceFile = join(directory,id,'device.json');
      const disk = join(directory,id,'work.qcow2');
      const device: unknown = existsSync(deviceFile) ? JSON.parse(readFileSync(deviceFile,'utf8')) : null;
      return { id, bytes: existsSync(disk) ? lstatSync(disk).size : null, device };
    }) : [];
    return { initialized: true,
      images: db.prepare('SELECT id,state,job_id,bytes,parent_id FROM workspace_images').all(),
      leases: db.prepare('SELECT id,image_id,assignment_id,attempt,mode,state,result_artifact_id FROM workspace_leases').all(),
      disks };
  } finally { db.close(); }
}

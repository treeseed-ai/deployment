import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceCatalog } from './workspace-catalog.js';

interface RecoveryLease {
  id: string; assignment_id: string; provider_id: string; attempt: number; mode: string;
  publication: string; state: string; expires_at: string; result_artifact_id: string | null;
}

export function recoverableAnalysis(lease: RecoveryLease, now: Date) {
  return lease.mode === 'analysis' && lease.publication === 'denied'
    && ['active', 'quarantined', 'released'].includes(lease.state)
    && Number.isFinite(Date.parse(lease.expires_at)) && Date.parse(lease.expires_at) <= now.getTime();
}

/** Interrupted leases require a stopped broker; released-only collection is safe during execution.
 * Released catalog authority proves teardown. Never reads guest filesystems. */
export async function recoverExpiredAnalysis(root: string, now = new Date(), releasedOnly = false) {
  const database = join(root, 'catalog.db'), db = new DatabaseSync(database, { readOnly: true });
  let leases: RecoveryLease[];
  try { leases = db.prepare('SELECT * FROM workspace_leases').all() as unknown as RecoveryLease[]; }
  finally { db.close(); }
  const catalog = new WorkspaceCatalog(database), removed: string[] = [];
  try {
    for (const name of await readdir(join(root, 'jobs'))) {
      if (!/^sandbox-[a-zA-Z0-9-]{1,128}\.json$/u.test(name)) continue;
      const path = join(root, 'jobs', name), metadata = await lstat(path);
      if (!metadata.isFile() || metadata.uid !== process.getuid?.() || metadata.nlink !== 1
        || (metadata.mode & 0o077) || metadata.size > 1_048_576) throw new Error('Recovery journal custody changed.');
      const job = JSON.parse(await readFile(path, 'utf8'));
      const lease = leases.find(value => value.id === job.leaseId);
      if (!lease || (releasedOnly ? lease.state !== 'released' || lease.mode !== 'analysis' || lease.publication !== 'denied'
        : !recoverableAnalysis(lease, now))) continue;
      if (job.schemaVersion !== 'treeseed.assignment-source-job/v1'
        || job.owner?.assignmentId !== lease.assignment_id || job.owner?.providerId !== lease.provider_id
        || job.owner?.attempt !== lease.attempt || !/^workspace-lease-[a-f0-9-]{36}$/u.test(job.disk?.id)) {
        throw new Error('Recovery journal does not match analysis lease.');
      }
      const directory = join(root, 'leases', job.disk.id);
      if (job.disk.directory !== directory || job.disk.image !== join(directory, 'work.qcow2')) throw new Error('Recovery disk escaped custody.');
      let disk;
      try { disk = await lstat(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && lease.state === 'released') continue; throw error; }
      if (!disk.isDirectory() || disk.uid !== process.getuid?.() || (disk.mode & 0o077)
        || await realpath(directory) !== directory) throw new Error('Recovery disk custody changed.');
      if ((await readdir(directory)).some(value => !['work.qcow2', 'nbd.pid'].includes(value))) {
        if (releasedOnly) continue;
        throw new Error('Recovery disk remains attached or unclassified.');
      }
      const results = join(root, 'results'); await mkdir(results, { recursive: true, mode: 0o700 });
      const resultInfo = await lstat(results);
      if (!resultInfo.isDirectory() || resultInfo.uid !== process.getuid?.() || (resultInfo.mode & 0o077)
        || await realpath(results) !== results) throw new Error('Recovery result custody changed.');
      const receiptId = `${name.slice(0, -5)}-recovery.json`, temporary = join(results, `${randomUUID()}.tmp`);
      if (lease.state !== 'released') {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ schemaVersion: 'treeseed.source-result/v1',
          sandboxId: name.slice(0, -5), leaseId: lease.id, status: 'interrupted', result: null,
          sourceReference: null, teardownVerified: true, completedAt: now.toISOString(), recovery: 'expired-analysis' })); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, join(results, receiptId));
        const parent = await open(results, 'r'); try { await parent.sync(); } finally { await parent.close(); }
        catalog.recordDurableResult(lease.id, receiptId); catalog.release(lease.id, true);
      } else {
        const artifact = lease.result_artifact_id;
        if (!artifact || !/^sandbox-[a-zA-Z0-9-]{1,128}(?:-recovery)?\.json$/u.test(artifact)) throw new Error('Recovery result identity changed.');
        const resultPath = join(results, artifact), info = await lstat(resultPath);
        if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o077)
          || info.size > 16_777_216) throw new Error('Recovery result custody changed.');
        const result = JSON.parse(await readFile(resultPath, 'utf8'));
        if (result.leaseId !== lease.id || result.teardownVerified !== true) throw new Error('Recovery result does not prove teardown.');
      }
      await rm(directory, { recursive: true }); removed.push(job.disk.id);
    }
    return removed;
  } finally { catalog.close(); }
}

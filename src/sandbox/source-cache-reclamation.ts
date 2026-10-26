import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertSourceCacheCustody, type CacheRecoveryOperations } from './source-cache-recovery.js';

/** Reclaim only redundant host Git objects, under their existing acquisition
 * fence. Bundles, workspace images, simulations, candidates and leases are
 * outside this directory and never become reclamation candidates. */
export async function reclaimSourceCacheSpace(current: string, requiredBytes: number,
  operations: Pick<CacheRecoveryOperations, 'run'>) {
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes <= 0) throw new Error('Invalid source cache storage requirement.');
  const root = dirname(current);
  await assertSourceCacheCustody(root, true);
  const available = async () => { const fs = await statfs(root); return fs.bavail * fs.bsize >= requiredBytes; };
  if (await available()) return true;
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const cache = join(root, entry.name);
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name) || cache === current) continue;
    try { await assertSourceCacheCustody(cache, true); } catch { continue; }
    const lock = join(cache, 'acquisition.lock');
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
    try {
      // The same journal format lets ordinary recovery preserve a crashed
      // reclaimer's fence. Never steal an existing live or unknown fetch.
      await writeFile(join(lock, 'job.json'), JSON.stringify({ jobId: randomUUID(), pid: process.pid }), { mode: 0o600, flag: 'wx' });
      const image = join(cache, 'objects.ext4');
      let imageInfo;
      try {
        const creating = await lstat(`${image}.creating`).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return null;
        });
        if (creating) continue;
        imageInfo = await assertSourceCacheCustody(image, false);
        if (imageInfo.size <= 0) continue;
        let mounted = '';
        try { mounted = await operations.run('/usr/bin/findmnt', ['--noheadings', '--output', 'SOURCE', '--mountpoint', join(cache, 'mounted')]); }
        catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; }
        if (mounted || await operations.run('/usr/sbin/losetup', ['--associated', image])) continue;
      } catch { continue; } // Unknown custody or transport is retained, never forced.
      await rm(image);
      const directory = await open(cache, 'r'); try { await directory.sync(); } finally { await directory.close(); }
      process.stderr.write(`${JSON.stringify({ source: 'source-cache', status: 'reclaimed', cacheId: entry.name, allocatedBytes: imageInfo.blocks * 512 })}\n`);
    } finally { await rm(lock, { recursive: true }); }
    if (await available()) return true;
  }
  return available();
}

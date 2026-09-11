import { mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { initializeWorkspaceStorage, workspaceStorageRoot } from './workspace-block-store.js';
import { sourceCacheVolumeBytes, withSourceCacheVolume } from './source-cache-volume.js';

/** Fixed synthetic fixture through the manager; no caller paths, credentials or shell. */
export async function qualifySourceCacheQuota() {
  await initializeWorkspaceStorage();
  const directory = await mkdtemp(join(workspaceStorageRoot, 'cache-qualification-'));
  const limit = 1_048_576, capacity = sourceCacheVolumeBytes(limit);
  let safeToRemove = false;
  try {
    const result = await withSourceCacheVolume(directory, limit, async mounted => {
      const file = await open(join(mounted, 'synthetic-data'), 'wx', 0o600);
      let rejected = false, written = 0;
      try {
        const block = Buffer.alloc(1_048_576, 7);
        while (written <= capacity) {
          try { written += (await file.write(block)).bytesWritten; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOSPC') throw error; rejected = true; break; }
        }
        if (!rejected) throw new Error('Source cache did not enforce its filesystem quota.');
      } finally { await file.close(); }
      return { hardLimitEnforced: rejected, filesystemBytes: capacity, writtenBytes: written };
    });
    safeToRemove = true;
    return { schemaVersion: 'treeseed.source-cache-qualification/v1', ...result,
      trustedHostFilesystemOnly: true, guestFilesystemMountedOnHost: false, unmounted: true };
  } finally { if (safeToRemove) await rm(directory, { recursive: true }); }
}

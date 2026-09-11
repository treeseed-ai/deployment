import { expect, it } from 'vitest';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceCacheVolumeBytes, withSourceCacheVolume } from '../src/sandbox/source-cache-volume.js';

it.skipIf(process.env.TREESEED_PRIVILEGED_CACHE_TESTS !== '1' || process.getuid?.() !== 0)(
  'kernel rejects writes beyond the fixed trusted-host cache without filling the parent filesystem', async () => {
    const root = await mkdtemp(join(tmpdir(), 'treeseed-kernel-cache-quota-'));
    const capacity = sourceCacheVolumeBytes(1_048_576);
    let unmounted = false;
    try {
      await withSourceCacheVolume(root, 1_048_576, async path => {
        const file = await open(join(path, 'synthetic'), 'wx', 0o600);
        try {
          const block = Buffer.alloc(1_048_576, 9);
          let written = 0, code: string | undefined;
          try { while (written <= capacity) written += (await file.write(block)).bytesWritten; }
          catch (error) { code = (error as NodeJS.ErrnoException).code; }
          expect(code).toBe('ENOSPC'); expect(written).toBeLessThan(capacity);
        } finally { await file.close(); }
      });
      unmounted = true;
    } finally { if (unmounted) await rm(root, { recursive: true }); }
  }, 30_000);

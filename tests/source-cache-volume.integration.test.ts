import { expect, it } from 'vitest';
import { access, mkdtemp, open, readdir, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceCacheVolumeBytes, withSourceCacheVolume } from '../src/sandbox/source-cache-volume.js';
import { acquireSourceBundle } from '../src/sandbox/source-git-cache.js';
import { runSourceGit } from '../src/sandbox/source-git-transport.js';
import type { SourceWorkspaceAuthorization } from '@treeseed/sdk/capacity-provider/sandbox';

it(
  'kernel rejects writes beyond the fixed trusted-host cache without filling the parent filesystem', async () => {
    if (process.env.TREESEED_PRIVILEGED_CACHE_TESTS !== '1' || process.getuid?.() !== 0) {
      throw new Error('Explicit TREESEED_PRIVILEGED_CACHE_TESTS=1 on the owning trusted root host is required; native cache quota coverage cannot be skipped.');
    }
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

it('native full parent filesystem denies acquisition twice without poisoning the live owner fence or allocating source bytes', async () => {
  if (process.env.TREESEED_PRIVILEGED_CACHE_TESTS !== '1' || process.getuid?.() !== 0) {
    throw new Error('Explicit owning trusted root host is required; native storage admission cannot be skipped.');
  }
  const root = await mkdtemp(join(tmpdir(), 'treeseed-native-admission-'));
  let unmounted = false;
  try {
    // A real bounded parent volume exercises native statfs without filling the host.
    await withSourceCacheVolume(root, 1_048_576, async parent => {
      const storage = await mkdtemp(join(parent, 'source-'));
      const available = await statfs(storage), limit = 1_048_576;
      expect(available.bavail * available.bsize).toBeLessThan(sourceCacheVolumeBytes(limit) + limit + 268_435_456);
      const now = new Date();
      const authorization: SourceWorkspaceAuthorization = {
        schemaVersion: 'treeseed.source-workspace-authorization/v1', id: 'authority', providerId: 'provider', assignmentId: 'assignment', attempt: 1,
        source: { controlPlaneId: 'control-plane', teamId: 'team', projectId: 'project', repositoryId: 'repository', commit: 'a'.repeat(40), formatVersion: 1, profile: 'source-only' },
        mode: 'analysis', acquisition: 'upstream-public', publication: 'denied', issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      };
      const input = { authorization, repository: { owner: 'example', name: 'project', cloneUrl: 'https://github.com/example/project.git' }, maxBundleBytes: limit };
      const before = structuredClone(input), failures: unknown[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await acquireSourceBundle(input, { root: storage, initialize: async () => {}, now: () => now, volume: withSourceCacheVolume, run: runSourceGit }); failures.push('unexpected success'); }
        catch (error) { failures.push(error); }
      }
      expect(failures.map(error => error instanceof Error ? error.message : error)).toEqual(Array(2).fill('Source cache storage admission is full; reclaim inactive caches before retrying.'));
      expect(input).toEqual(before);
      const caches = await readdir(join(storage, 'git')); expect(caches).toHaveLength(1);
      const cache = join(storage, 'git', caches[0]!);
      for (const name of ['acquisition.lock', 'objects.ext4', 'objects.ext4.creating']) await expect(access(join(cache, name))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(join(cache, 'mounted'))).toEqual([]);
      expect(await readdir(join(storage, 'bundles'))).toEqual([]);
    });
    unmounted = true;
  } finally { if (unmounted) await rm(root, { recursive: true }); }
}, 30_000);

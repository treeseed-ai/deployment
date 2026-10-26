import { expect, it } from 'vitest';
import { access, mkdtemp, mkdir, open, readFile, readdir, rm, statfs, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceCacheVolumeBytes, withSourceCacheVolume } from '../src/sandbox/source-cache-volume.js';
import { acquireSourceBundle } from '../src/sandbox/source-git-cache.js';
import { runSourceGit } from '../src/sandbox/source-git-transport.js';
import type { SourceWorkspaceAuthorization } from '@treeseed/sdk/capacity-provider/sandbox';

it('native source admission reclaims only an inactive fetch volume under real bounded filesystem pressure and preserves retained work', async () => {
  if (process.env.TREESEED_PRIVILEGED_CACHE_TESTS !== '1' || process.getuid?.() !== 0)
    throw new Error('Explicit owning trusted root host is required; native cache reclamation cannot be skipped.');
  const root = await mkdtemp(join(tmpdir(), 'source-cache-reclaim-native-')), exec = promisify(execFile);
  let unmounted = false;
  try {
    await withSourceCacheVolume(root, 201_326_592, async parent => {
      const storage = join(parent, 'storage'), git = join(storage, 'git'), current = join(git, 'a'.repeat(64)),
        idle = join(git, 'b'.repeat(64)), held = join(git, 'c'.repeat(64));
      for (const path of [storage, git, current, idle, held, join(idle, 'mounted'), join(held, 'acquisition.lock'), join(storage, 'bundles'), join(storage, 'simulations')])
        await mkdir(path, { mode: 0o700 });
      const idleImage = join(idle, 'objects.ext4'), heldImage = join(held, 'objects.ext4'), journal = join(held, 'acquisition.lock', 'job.json');
      await writeFile(idleImage, '', { mode: 0o600 });
      await exec('/usr/bin/fallocate', ['--length', '167772160', idleImage]); await exec('/usr/sbin/mkfs.ext4', ['-q', '-F', '-m', '0', idleImage]);
      await writeFile(heldImage, 'unknown in-flight source', { mode: 0o600 }); await writeFile(journal, 'original unresolved owner', { mode: 0o600 });
      const bundle = join(storage, 'bundles', 'immutable.bundle'), product = join(storage, 'simulations', 'retained-product');
      await writeFile(bundle, 'original immutable bundle', { mode: 0o400 }); await writeFile(product, 'original retained work', { mode: 0o600 });
      const before = await statfs(git), limit = 1_048_576;
      expect(before.bavail * before.bsize).toBeLessThan(sourceCacheVolumeBytes(limit) + limit + 268_435_456);
      await withSourceCacheVolume(current, limit, async mounted => {
        const file = join(mounted, 'source-evidence'); await writeFile(file, 'new admitted source'); expect(await readFile(file, 'utf8')).toBe('new admitted source');
      });
      await expect(access(idleImage)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(join(idle, 'acquisition.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(heldImage, 'utf8')).toBe('unknown in-flight source'); expect(await readFile(journal, 'utf8')).toBe('original unresolved owner');
      expect(await readFile(bundle, 'utf8')).toBe('original immutable bundle'); expect(await readFile(product, 'utf8')).toBe('original retained work');
      // Existing ready-cache reuse remains the same path and quota.
      await withSourceCacheVolume(current, limit, async mounted => { expect(await readFile(join(mounted, 'source-evidence'), 'utf8')).toBe('new admitted source'); });
    });
    unmounted = true;
  } finally { if (unmounted) await rm(root, { recursive: true }); }
}, 60_000);

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

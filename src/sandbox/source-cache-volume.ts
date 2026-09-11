import { execFile } from 'node:child_process';
import { lstat, mkdir, open, realpath, rename, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export interface SourceCacheVolumeOperations {
  run(command: string, args: string[]): Promise<string>;
}
const operations: SourceCacheVolumeOperations = {
  run: async (command, args) => (await exec(command, args, { timeout: 120_000, maxBuffer: 65_536,
    encoding: 'utf8', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } })).stdout.trim(),
};
export function sourceCacheVolumeBytes(bundleLimit: number) {
  if (!Number.isSafeInteger(bundleLimit) || bundleLimit < 1 || bundleLimit > 8_589_934_592) throw new Error('Invalid source cache quota.');
  return Math.ceil((bundleLimit * 2 + 67_108_864) / 4096) * 4096;
}

/** Trusted-host Git metadata only. This filesystem is NEVER exposed to a guest.
 * A fixed, preallocated filesystem bounds all fetch descendants and aggregate files,
 * unlike RLIMIT_FSIZE or a post-fetch size check. Caller holds the acquisition fence. */
export async function withSourceCacheVolume<T>(cache: string, bundleLimit: number,
  action: (directory: string) => Promise<T>, commands = operations): Promise<T> {
  const bytes = sourceCacheVolumeBytes(bundleLimit), info = await lstat(cache);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) || await realpath(cache) !== cache) throw new Error('Unsafe source cache custody.');
  const image = join(cache, 'objects.ext4'), mount = join(cache, 'mounted');
  await mkdir(mount, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
  const mounted = await lstat(mount);
  if (!mounted.isDirectory() || mounted.uid !== process.getuid?.() || (mounted.mode & 0o077) || await realpath(mount) !== mount) throw new Error('Unsafe source cache mount.');
  const prior = await lstat(image).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined; });
  if (prior) {
    if (!prior.isFile() || prior.nlink !== 1 || prior.uid !== process.getuid?.() || (prior.mode & 0o077)
      || prior.size !== bytes || await realpath(image) !== image) throw new Error('Source cache quota/custody changed; explicit recovery required.');
  } else {
    const available = await statfs(cache);
    if (available.bavail * available.bsize < bytes + bundleLimit + 268_435_456) throw new Error('Source cache storage admission is full; reclaim inactive caches before retrying.');
    const temporary = `${image}.creating`, handle = await open(temporary, 'wx', 0o600); await handle.close();
    // Incomplete creation is fenced, never reinterpreted as an initialized filesystem.
    await commands.run('/usr/bin/fallocate', ['--length', String(bytes), temporary]);
    await commands.run('/usr/sbin/mkfs.ext4', ['-q', '-F', '-m', '0', temporary]);
    const file = await open(temporary, 'r'); try { await file.sync(); } finally { await file.close(); }
    await rename(temporary, image);
    const parent = await open(cache, 'r'); try { await parent.sync(); } finally { await parent.close(); }
  }
  await commands.run('/usr/bin/mount', ['--types', 'ext4', '--options', 'loop,nodev,nosuid,noexec', image, mount]);
  try { return await action(mount); }
  finally {
    // Never lazy/force unmount: descendants still writing must retain the fence.
    const device = await commands.run('/usr/bin/findmnt', ['--noheadings', '--output', 'SOURCE', '--mountpoint', mount]);
    if (!/^\/dev\/loop[0-9]+$/u.test(device)
      || await commands.run('/usr/sbin/losetup', ['--noheadings', '--output', 'BACK-FILE', device]) !== image) throw new Error('Source cache mount ownership is uncertain.');
    await commands.run('/usr/bin/umount', [mount]);
  }
}

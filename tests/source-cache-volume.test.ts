import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceCacheVolumeBytes, withSourceCacheVolume } from '../src/sandbox/source-cache-volume.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'treeseed-cache-quota-')); roots.push(root);
  const calls: Array<{ command: string; args: string[] }> = [];
  const commands = { run: async (command: string, args: string[]) => {
    calls.push({ command, args });
    if (command.endsWith('/fallocate')) await truncate(args[2]!, Number(args[1]));
    if (command.endsWith('/findmnt')) return '/dev/loop42';
    if (command.endsWith('/losetup')) return join(root, 'objects.ext4');
    return '';
  } };
  return { root, calls, commands };
}
it('reserves a fixed filesystem before fetch and unmounts before returning', async () => {
  const f = await fixture();
  expect(await withSourceCacheVolume(f.root, 1024, async path => {
    expect(path).toBe(join(f.root, 'mounted'));
    expect(f.calls.at(-1)?.command).toBe('/usr/bin/mount'); return 'bundle';
  }, f.commands)).toBe('bundle');
  expect(f.calls[0]).toEqual({ command: '/usr/bin/fallocate', args: ['--length', String(sourceCacheVolumeBytes(1024)), join(f.root, 'objects.ext4.creating')] });
  expect(f.calls.at(-1)?.command).toBe('/usr/bin/umount');
  f.calls.length = 0;
  await withSourceCacheVolume(f.root, 1024, async () => undefined, f.commands);
  expect(f.calls.some(call => call.command.endsWith('/mkfs.ext4'))).toBe(false);
  await expect(withSourceCacheVolume(f.root, 8192, async () => undefined, f.commands)).rejects.toThrow('quota/custody');
});
it('does not unmount a different loop device and retains failed custody', async () => {
  const f = await fixture(), run = f.commands.run;
  f.commands.run = async (command, args) => command.endsWith('/losetup') ? '/unrelated' : run(command, args);
  await expect(withSourceCacheVolume(f.root, 1024, async () => undefined, f.commands)).rejects.toThrow('ownership');
  expect(f.calls.some(call => call.command.endsWith('/umount'))).toBe(false);
});
it('never forces an in-use filesystem and propagates fetch failure after teardown', async () => {
  const f = await fixture();
  await expect(withSourceCacheVolume(f.root, 1024, async () => { throw new Error('fetch failed'); }, f.commands)).rejects.toThrow('fetch failed');
  expect(f.calls.at(-1)).toEqual({ command: '/usr/bin/umount', args: [join(f.root, 'mounted')] });
});
it('rejects invalid limits before filesystem access', async () => {
  for (const bytes of [0, -1, NaN, Number.MAX_SAFE_INTEGER]) await expect(withSourceCacheVolume('/unused', bytes, async () => undefined)).rejects.toThrow('quota');
});

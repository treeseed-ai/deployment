import { afterEach, expect, it, vi } from 'vitest';
import { access, mkdtemp, mkdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSourceCacheVolume } from '../src/sandbox/source-cache-volume.js';

const pressure = vi.hoisted(() => ({ blockingImage: '' }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, statfs: async (path: string) => {
    const result = await fs.statfs(path);
    if (pressure.blockingImage && await fs.access(pressure.blockingImage).then(() => true, () => false)) return { ...result, bavail: 0 };
    return result;
  } };
});
const roots: string[] = [];
afterEach(async () => { pressure.blockingImage = ''; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('reclaims only an inactive fetch cache under storage pressure before admitting the unchanged source quota', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-cache-pressure-')); roots.push(root);
  const git = join(root, 'git'), current = join(git, 'a'.repeat(64)), idle = join(git, 'b'.repeat(64));
  for (const path of [git, current, idle, join(idle, 'mounted'), join(root, 'bundles'), join(root, 'simulations')]) await mkdir(path, { mode: 0o700 });
  const idleImage = join(idle, 'objects.ext4'), bundle = join(root, 'bundles', 'retained.bundle'), product = join(root, 'simulations', 'retained.git');
  await writeFile(idleImage, 'cached upstream objects', { mode: 0o600 });
  await writeFile(bundle, 'immutable source bundle'); await writeFile(product, 'retained delivered work');
  pressure.blockingImage = idleImage;
  const commands = { run: async (command: string, args: string[]) => {
    if (command.endsWith('/fallocate')) await truncate(args[2]!, Number(args[1]));
    if (command.endsWith('/findmnt')) {
      if (args.at(-1) === join(current, 'mounted')) return '/dev/loop42';
      throw Object.assign(new Error('not mounted'), { code: 1 });
    }
    if (command.endsWith('/losetup') && !args.includes('--associated')) return join(current, 'objects.ext4');
    return '';
  } };
  expect(await withSourceCacheVolume(current, 1024, async () => 'authorized bundle', commands)).toBe('authorized bundle');
  await expect(access(idleImage)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(bundle, 'utf8')).toBe('immutable source bundle'); expect(await readFile(product, 'utf8')).toBe('retained delivered work');
  await expect(access(join(idle, 'acquisition.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
});

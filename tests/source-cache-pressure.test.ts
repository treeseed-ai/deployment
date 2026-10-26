import { afterEach, expect, it, vi } from 'vitest';
import { access, chmod, link, mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSourceCacheVolume } from '../src/sandbox/source-cache-volume.js';
import { reclaimSourceCacheSpace } from '../src/sandbox/source-cache-reclamation.js';

const pressure = vi.hoisted(() => ({ blockingImage: '' }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, statfs: async (path: string) => {
    const result = await fs.statfs(path);
    if (pressure.blockingImage && await fs.access(pressure.blockingImage).then(() => true, () => false)) return { ...result, bavail: 0 };
    return result;
  } };
});

it('retains live unknown mounted linked unsafe and unrelated cache entries without touching work or forcing transport cleanup', async () => {
  for (const mode of ['current', 'locked', 'mounted', 'loop', 'unknown', 'directory', 'image', 'symlink', 'hardlink', 'creating', 'unrelated']) {
    const root = await mkdtemp(join(tmpdir(), 'source-cache-retention-')); roots.push(root);
    const current = join(root, 'a'.repeat(64)), victim = mode === 'current' ? current : join(root, mode === 'unrelated' ? 'other-data' : 'b'.repeat(64));
    await mkdir(current, { mode: 0o700 }); if (victim !== current) await mkdir(victim, { mode: 0o700 });
    const image = join(victim, 'objects.ext4'), original = join(root, 'retained-product');
    await writeFile(original, 'retained work', { mode: 0o600 });
    if (mode === 'symlink') await symlink(original, image);
    else if (mode === 'hardlink') await link(original, image);
    else await writeFile(image, 'original cached source', { mode: 0o600 });
    if (mode === 'locked') { await mkdir(join(victim, 'acquisition.lock')); await writeFile(join(victim, 'acquisition.lock', 'job.json'), 'unknown original owner'); }
    if (mode === 'directory') await chmod(victim, 0o755);
    if (mode === 'image') await chmod(image, 0o644);
    if (mode === 'creating') await writeFile(`${image}.creating`, 'interrupted allocation');
    pressure.blockingImage = image;
    const calls: string[] = [], run = async (command: string, _args: string[]) => {
      calls.push(command);
      if (mode === 'unknown') throw Object.assign(new Error('inspection denied'), { code: 'EACCES' });
      return mode === 'mounted' && command.endsWith('findmnt') ? '/dev/loop42' : mode === 'loop' && command.endsWith('losetup') ? 'associated device' : '';
    };
    const before = await readFile(image, 'utf8');
    expect(await reclaimSourceCacheSpace(current, 1024, { run }), mode).toBe(false);
    expect(await readFile(image, 'utf8'), mode).toBe(before); expect(await readFile(original, 'utf8')).toBe('retained work');
    expect(calls.every(command => command.endsWith('findmnt') || command.endsWith('losetup'))).toBe(true);
    if (mode === 'locked') expect(await readFile(join(victim, 'acquisition.lock', 'job.json'), 'utf8')).toBe('unknown original owner');
    else await expect(access(join(victim, 'acquisition.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

it('uses the existing fetch fence for concurrent reclamation and remains idempotent after the exact image is removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-cache-concurrent-')); roots.push(root);
  const current = join(root, 'a'.repeat(64)), victim = join(root, 'b'.repeat(64));
  await mkdir(current, { mode: 0o700 }); await mkdir(victim, { mode: 0o700 });
  const image = join(victim, 'objects.ext4'); await writeFile(image, 'redundant source objects', { mode: 0o600 }); pressure.blockingImage = image;
  let entered!: () => void, release!: () => void; const observed = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; }); let probes = 0;
  const run = async () => { if (++probes === 1) { entered(); await held; } return ''; };
  const first = reclaimSourceCacheSpace(current, 1024, { run }); await observed;
  expect(await reclaimSourceCacheSpace(current, 1024, { run })).toBe(false);
  const journal = JSON.parse(await readFile(join(victim, 'acquisition.lock', 'job.json'), 'utf8'));
  expect(journal).toMatchObject({ pid: process.pid }); expect(journal.jobId).toMatch(/^[a-f0-9-]{36}$/u);
  release(); expect(await first).toBe(true); expect(await reclaimSourceCacheSpace(current, 1024, { run })).toBe(true);
  expect(probes).toBe(2); await expect(access(image)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects invalid space requirements before probing or changing cache ownership', async () => {
  for (const bytes of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    await expect(reclaimSourceCacheSpace('/not-accessed', bytes, { run: async () => { throw new Error('must not run'); } })).rejects.toThrow('requirement');
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

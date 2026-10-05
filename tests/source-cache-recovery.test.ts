import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { recoverSourceCacheFence } from '../src/sandbox/source-cache-recovery.js';
it('recovers a dead fetch owner only after transport is detached, preserving cached image', async () => {
  const root = await mkdtemp(join(tmpdir(),'source-recovery-')), lock = join(root,'acquisition.lock');
  try {
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock,'job.json'), JSON.stringify({ pid: 1234, jobId: 'a'.repeat(36) }), { mode: 0o600 });
    await writeFile(join(root,'objects.ext4'),'trusted-cache', { mode: 0o600 });
    const ops = { alive: () => true, run: async () => '' };
    expect(await recoverSourceCacheFence(root,ops)).toBe(false);
    ops.alive = () => false;
    expect(await recoverSourceCacheFence(root,ops)).toBe(true);
    await access(join(root,'objects.ext4'));
    await expect(access(lock)).rejects.toThrow();
  } finally { await rm(root,{recursive:true,force:true}); }
});
it('retains the fence if an orphan transport still owns the filesystem', async () => {
  const root = await mkdtemp(join(tmpdir(),'source-recovery-')), lock = join(root,'acquisition.lock');
  try {
    await mkdir(lock,{mode:0o700});
    await writeFile(join(lock,'job.json'),JSON.stringify({pid:1234,jobId:'b'.repeat(36)}),{mode:0o600});
    const ops = { alive: () => false, run: async (command: string) => command.endsWith('findmnt') ? '' : '/dev/loop7' };
    await expect(recoverSourceCacheFence(root,ops)).rejects.toThrow('attached loop');
    await access(lock);
  } finally { await rm(root,{recursive:true,force:true}); }
});

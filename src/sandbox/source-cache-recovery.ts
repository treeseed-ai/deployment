import { execFile } from 'node:child_process';
import { lstat, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export interface CacheRecoveryOperations {
  alive(pid: number): boolean;
  run(command: string, args: string[]): Promise<string>;
}
const production: CacheRecoveryOperations = {
  alive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
  },
  async run(command, args) {
    return (await exec(command, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 65_536 })).stdout.trim();
  },
};
async function owned(path: string, directory: boolean) {
  const info = await lstat(path);
  if ((directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
    || info.uid !== process.getuid?.() || info.mode & 0o077 || await realpath(path) !== path) {
    throw new Error('Source cache recovery custody is invalid.');
  }
  return info;
}
/** Recover only a trusted-host fetch fence after its owning process is gone.
 * Never kills a process, mounts guest content, or removes source/work/candidate images. */
export async function recoverSourceCacheFence(cache: string, operations = production) {
  const lock = join(cache, 'acquisition.lock');
  const exists = await lstat(lock).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  });
  if (!exists) return false;
  await owned(cache, true); await owned(lock, true);
  const journal = join(lock, 'job.json'), info = await owned(journal, false);
  if (info.size > 4096) throw new Error('Source cache recovery journal exceeds its bound.');
  const job = JSON.parse(await readFile(journal, 'utf8')) as { pid?: unknown; jobId?: unknown };
  if (!Number.isSafeInteger(job.pid) || Number(job.pid) < 2 || !/^[a-f0-9-]{36}$/u.test(String(job.jobId))) {
    throw new Error('Source cache recovery owner is invalid.');
  }
  if (operations.alive(Number(job.pid))) return false;
  const mount = join(cache, 'mounted'), image = join(cache, 'objects.ext4');
  let device = '';
  try { device = await operations.run('/usr/bin/findmnt', ['--noheadings','--output','SOURCE','--mountpoint',mount]); }
  catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; }
  if (device) {
    if (!/^\/dev\/loop[0-9]+$/u.test(device)
      || await operations.run('/usr/sbin/losetup', ['--noheadings','--output','BACK-FILE',device]) !== image) {
      throw new Error('Source cache recovery mount ownership is uncertain.');
    }
    await operations.run('/usr/bin/umount', [mount]); // busy filesystem remains fenced
  }
  if (await operations.run('/usr/sbin/losetup', ['--associated', image])) {
    throw new Error('Source cache recovery still has an attached loop device.');
  }
  const creating = `${image}.creating`;
  const unfinished = await lstat(creating).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  });
  if (unfinished) { await owned(creating, false); await rm(creating); }
  await rm(lock, { recursive: true }); // exact root-owned fetch journal, never execution work
  return true;
}

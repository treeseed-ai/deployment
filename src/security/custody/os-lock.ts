import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { LocalSecretCustody } from './local.js';

/** Linux custody transaction lock, shared across processes. flock uses the
 * inherited open-file description: closing the parent's descriptor releases
 * it, including on process death. Never delete the inode or use stale PID leases.
 * Keep the lock around read -> bounded exchange -> encrypted record replacement.
 */
export async function withOsCustodyLock<T>(root: string, run: () => Promise<T>, timeoutSeconds = 15): Promise<T> {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 60) throw new Error('Invalid custody lock timeout');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  new LocalSecretCustody(root);
  const fd = openSync(join(root, 'transaction.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size !== 0) throw new Error('Unsafe custody lock');
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/flock', ['--exclusive', '--timeout', String(timeoutSeconds), '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
      child.once('error', () => reject(new Error('OS custody locking is unavailable')));
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('OS custody is busy; retry the operation')));
    });
    return await run();
  } finally { closeSync(fd); }
}

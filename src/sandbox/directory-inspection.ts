import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/** Internal owning-host observations. Public operations supply fixed custody roots. */
export function owningHostStat(path: string) {
 let local: import('node:fs').Stats;
 try { local = lstatSync(path); }
 catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  try { lstatSync(`/proc/1/root${path}`); }
  catch (hostError) {
   if ((hostError as NodeJS.ErrnoException).code === 'ENOENT') throw error;
   throw new Error('Owning host observation is unavailable.');
  }
  throw new Error('Owning host and local absence disagree.');
 }
 let host: import('node:fs').Stats;
 try { host = lstatSync(`/proc/1/root${path}`); }
 catch { throw new Error('Owning host observation is unavailable.'); }
 if (!Number.isSafeInteger(local.dev) || !Number.isSafeInteger(local.ino)
  || local.dev !== host.dev || local.ino !== host.ino) throw new Error('Owning host inode disagrees.');
 return host;
}

// Mutate the original observation so failure retains an observed present root.
export function inspectManagedDirectory(root: string, observation: { rootPresent: boolean | null;
 entries: Array<{ name: string; type: 'directory' | 'file' | 'symlink' | 'other' }> }) {
 if (!isAbsolute(root) || resolve(root) !== root) throw new Error('Canonical owning directory required.');
 let ancestor = dirname(root);
 while (ancestor !== '/') {
  if (realpathSync(ancestor) !== ancestor || !owningHostStat(ancestor).isDirectory()) throw new Error('Owning ancestor unavailable.');
  ancestor = dirname(ancestor);
 }
 try {
  const stat = owningHostStat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root) throw new Error('Owning directory is redirected.');
  observation.rootPresent = true;
  observation.entries = readdirSync(`/proc/1/root${root}`).sort().map(name => {
   if (!name || name === '.' || name === '..' || /[\/\0\r\n]/u.test(name)) throw new Error('Malformed owning entry.');
   const entry = owningHostStat(resolve(root, name));
   return { name, type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' };
  });
 } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || observation.rootPresent === true) throw error;
  observation.rootPresent = false;
 }
}

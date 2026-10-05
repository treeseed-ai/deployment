import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import type { HostConfiguration } from '@treeseed/sdk/deployment';
import { componentCredential } from '../core/component-credential.js';
import { readComponentCredential } from './component-sealed.js';

/** Serialized supervisor bootstrap only. Reuses existing sealed values; never
 * accepts arbitrary destination paths, plaintext files or environment fallback.
 */
export function ensureComponentCredential(host: HostConfiguration, id: string, create: () => string,
  declaredPath = `/etc/treeseed/credentials/${id}`) {
  const secret = componentCredential(host, id, declaredPath);
  if (secret.provider !== 'systemd-credential') throw new Error('Component bootstrap requires OS-sealed custody');
  const root = '/etc/treeseed/credentials';
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o022)) throw new Error('Managed credential directory is unsafe');
  if (existsSync(secret.reference)) return readComponentCredential(host, id, declaredPath);
  let plaintext: Buffer | undefined;
  const temporary = `${secret.reference}.${randomUUID()}.new`;
  try {
    plaintext = Buffer.from(create());
    if (!plaintext.length || plaintext.length > 1_048_576 || plaintext.includes(0)) throw new Error('Invalid generated credential');
    const sealed = execFileSync('/usr/bin/systemd-creds', ['encrypt', '--with-key=host', `--name=${secret.name}`, '-', '-'],
      { input: plaintext, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000, maxBuffer: 1_048_576 });
    writeFileSync(temporary, sealed, { mode: 0o600, flag: 'wx' });
    // Atomic no-replace publication: even a concurrent creator or dangling
    // symlink must never be overwritten by initialization.
    linkSync(temporary, secret.reference);
    return plaintext.toString('utf8');
  } catch { throw new Error(`Managed component credential ${id} could not be initialized`); }
  finally { plaintext?.fill(0); if (existsSync(temporary)) unlinkSync(temporary); }
}

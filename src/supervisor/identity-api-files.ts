import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import type { ComponentRelease, HostConfiguration } from '@treeseed/sdk/deployment';
import { identityApiRuntimeSchema } from '@treeseed/sdk/identity';
import { apiIdentityMaterial } from '../identity/api-material.js';
import { readComponentCredential } from './component-sealed.js';
import { replaceRuntimeCredential } from './component.js';

const parent = '/run/treeseed/identity-clients';
const root = `${parent}/api`;
const mount = '/run/treeseed/identity/api';
type Owner = { uid: number; gid: number };

function directory() {
  let path = '';
  for (const part of `${root}/credentials`.split('/').filter(Boolean)) {
    path += `/${part}`;
    if (!existsSync(path)) mkdirSync(path, { mode: path === root || path === `${root}/credentials` ? 0o755 : 0o700 });
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)
      || (path === parent && (stat.mode & 0o077))) throw new Error('Unsafe API Identity runtime custody');
  }
}

function readOwned(name: string, owner: Owner) {
  const fd = openSync(`${root}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== owner.uid || stat.gid !== owner.gid
      || (stat.mode & 0o7777) !== 0o400 || stat.size < 24 || stat.size > 16384) throw new Error();
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function inventory(next: Map<string, Buffer>, owner: Owner) {
  const allowed = new Set(next.keys());
  if (existsSync(`${root}/runtime.json`)) {
    const previous = readOwned('runtime.json', owner);
    try {
      const config = identityApiRuntimeSchema.parse(JSON.parse(previous.toString('utf8')));
      for (const id of [config.sessionKeys.active.credentialReference,
        ...config.sessionKeys.historical.map(item => item.credentialReference),
        ...config.applications.map(item => item.signingKeyReference)]) allowed.add(`credentials/${id}`);
    } finally { previous.fill(0); }
  }
  const names = [...readdirSync(root).filter(name => name !== 'credentials'),
    ...readdirSync(`${root}/credentials`).map(name => `credentials/${name}`)];
  for (const name of names) {
    const final = name.replace(/\.tmp-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u, '');
    if (!allowed.has(final)) throw new Error('Unexpected API Identity runtime file');
    const value = readOwned(name, owner);
    value.fill(0);
  }
  return names;
}

/** Supervisor-only, called with API writers stopped. Resolve everything before
 * mutation, commit the descriptor last, and never publish plaintext in receipts.
 * This is deliberately not exposed as a caller-controlled supervisor operation.
 */
export function materializeApiIdentityRuntime(host: HostConfiguration, component: ComponentRelease) {
  const material = apiIdentityMaterial(host, component, id => Buffer.from(readComponentCredential(host, id)));
  let mutated = false;
  let names: string[] = [];
  try {
    directory();
    names = inventory(material.files, material.owner);
    let same = names.length === material.files.size;
    for (const [name, value] of material.files) {
      if (!names.includes(name)) { same = false; continue; }
      const previous = readOwned(name, material.owner);
      try { if (!previous.equals(value)) same = false; }
      finally { previous.fill(0); }
    }
    if (same) return { action: 'noop' as const, directory: root, mount };
    mutated = true;
    for (const [name, value] of material.files) if (name !== 'runtime.json') replaceRuntimeCredential(`${root}/${name}`, value, material.owner);
    for (const name of names) if (!material.files.has(name)) unlinkSync(`${root}/${name}`);
    replaceRuntimeCredential(`${root}/runtime.json`, material.files.get('runtime.json')!, material.owner);
    return { action: 'materialized' as const, directory: root, mount };
  } catch {
    if (mutated) {
      // Every target was validated above or is an exact new descriptor-owned
      // name. Never recursively remove directories or unknown user files.
      for (const name of new Set([...names, ...material.files.keys()])) if (existsSync(`${root}/${name}`)) unlinkSync(`${root}/${name}`);
    }
    throw new Error('API Identity runtime materialization failed; writers must remain stopped');
  } finally { material.clear(); }
}

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { componentReleaseSchema, hostConfigurationSchema, type ComponentRelease, type HostConfiguration } from '@treeseed/sdk/deployment';
import { postgresClientMaterial } from '../postgres/client-files.js';
import { readComponentCredential } from './component-sealed.js';
import { replaceRuntimeCredential } from './component.js';

const names = ['password', 'username', 'database', 'hostname', 'port', 'ca.pem', 'url', 'jdbc-url'];
const root = '/run/treeseed/postgres-clients';

function directory(componentId: string, requirementId: string, phase: 'migration' | 'runtime', create: boolean) {
  if (![componentId, requirementId].every(value => /^[a-z][a-z0-9-]{0,62}$/u.test(value)) || !['migration', 'runtime'].includes(phase)) throw new Error('Invalid PostgreSQL client identity');
  const target = `${root}/${componentId}/${requirementId}/${phase}`;
  let current = '';
  for (const part of target.split('/').filter(Boolean)) {
    current += `/${part}`;
    if (!existsSync(current)) {
      if (!create) return null;
      mkdirSync(current, { mode: current === target ? 0o755 : 0o700 });
    }
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)
      || (current === root && (stat.mode & 0o077))) throw new Error('Unsafe PostgreSQL client custody');
  }
  if (readdirSync(target).some(name => !names.includes(name))) throw new Error('Unexpected PostgreSQL client custody files');
  return target;
}

/** The published Compose service mounts only its phase directory at the
 * renderer's standard allocation mount. The host parent remains root-private.
 */
export function materializePostgresClient(input: HostConfiguration, selected: ComponentRelease, requirementId: string, phase: 'migration' | 'runtime') {
  const host = hostConfigurationSchema.parse(input), component = componentReleaseSchema.parse(selected);
  const lifecycle = component.runtime.postgresLifecycle?.find(item => item.requirementId === requirementId);
  const allocation = host.postgres?.allocations.find(item => item.requirementId === requirementId);
  if (!lifecycle || !allocation || !host.postgres?.requirements.some(item => item.id === requirementId && item.componentId === component.componentId && item.enabled)) throw new Error('Verified component database allocation required');
  const trust = '/run/treeseed/postgres/tls/cert.pem';
  for (const path of ['/run', '/run/treeseed', '/run/treeseed/postgres', '/run/treeseed/postgres/tls', trust]) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) || (path === trust ? !stat.isFile() : !stat.isDirectory())) throw new Error('Unsafe PostgreSQL TLS custody');
  }
  const secret = phase === 'migration' ? allocation.migrationCredentialReference : allocation.runtimeCredentialReference;
  const material = postgresClientMaterial(host.postgres, requirementId, phase, readComponentCredential(host, secret), readFileSync(trust, 'utf8'));
  const target = directory(component.componentId, requirementId, phase, true)!;
  try {
    for (const [name, value] of Object.entries(material.files)) {
      const plaintext = Buffer.from(value);
      try { replaceRuntimeCredential(join(target, name), plaintext, lifecycle.credentialOwner); }
      finally { plaintext.fill(0); }
    }
    return { requirementId, phase, directory: target, mount: material.mount, files: names };
  } catch {
    clearPostgresClient(component.componentId, requirementId, phase);
    throw new Error('PostgreSQL client materialization failed');
  }
}

export function clearPostgresClient(componentId: string, requirementId: string, phase: 'migration' | 'runtime') {
  const target = directory(componentId, requirementId, phase, false);
  if (!target) return;
  for (const name of readdirSync(target)) unlinkSync(join(target, name));
}

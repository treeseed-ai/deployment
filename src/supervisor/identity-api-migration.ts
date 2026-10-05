import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ComponentRelease, HostConfiguration } from '@treeseed/sdk/deployment';
import { apiIdentityMaterial } from '../identity/api-material.js';
import { managedIdentityClientPlan } from '../identity/client-plan.js';
import { OsSecretCustody } from '../security/custody/os.js';
import { paths } from '../core/paths.js';
import { componentStateRoot, replaceRuntimeCredential } from './component.js';
import { readComponentCredential } from './component-sealed.js';
import { reconcileManagedIdentityClients } from './identity-clients.js';

const root = '/run/treeseed/identity-clients/api-migration';
const names = ['runtime.json', 'reconciler.pem', 'ca.pem'];

export function requiresApiIdentityMigration(component: ComponentRelease) {
  return component.componentId === 'api' && component.runtime.dependencies.some(item => item.id === 'identity' && !item.optional);
}

function directory(create: boolean) {
  if (process.getuid?.() !== 0) throw new Error('Identity maintenance requires the host supervisor');
  let path = '';
  for (const part of root.split('/').filter(Boolean)) {
    path += `/${part}`;
    if (!existsSync(path)) {
      if (!create) return false;
      mkdirSync(path, { mode: path === root ? 0o755 : 0o700 });
    }
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022))
      throw new Error('Unsafe Identity maintenance custody');
  }
  for (const name of readdirSync(root)) {
    const stat = lstatSync(`${root}/${name}`);
    if (!names.includes(name) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o177))
      throw new Error('Unexpected Identity maintenance file');
  }
  return true;
}

/** Only called by the verified PostgreSQL lifecycle after writers stop and its
 * shared-server restore point gate passes. Never mounted in an API runtime.
 */
export async function prepareApiIdentityMigration(host: HostConfiguration, component: ComponentRelease, backupGeneration?: number) {
  if (!requiresApiIdentityMigration(component)) return;
  const material = apiIdentityMaterial(host, component, id => Buffer.from(readComponentCredential(host, id)));
  const plan = managedIdentityClientPlan(host);
  let key: Buffer | undefined, descriptor: Buffer | undefined;
  try {
    const clients = await reconcileManagedIdentityClients();
    const custody = new OsSecretCustody(join(componentStateRoot(host, 'identity'), 'identity-os'), false);
    const record = custody.run(store => store.read({ team: 'host', project: 'identity', environment: plan.environment,
      purpose: 'bootstrap', name: 'reconciler' }));
    if (!record || record.values.publicUrl !== plan.origin || !record.values.reconcilerKey) throw new Error('Identity reconciler custody unavailable');
    key = Buffer.from(record.values.reconcilerKey);
    descriptor = Buffer.from(JSON.stringify({ schemaVersion: 'treeseed.identity-api-migration/v1', issuer: plan.issuer,
      resource: plan.resource, ...(backupGeneration === undefined ? {} : { backupGeneration }),
      workloads: clients.workloads.map(({ action: _action, ...workload }) => workload) }));
    if (descriptor.length > 16384 || key.length > 16384) throw new Error('Identity maintenance input exceeds limit');
    directory(true);
    replaceRuntimeCredential(`${root}/reconciler.pem`, key, material.owner);
    replaceRuntimeCredential(`${root}/ca.pem`, readFileSync(`${paths.tls}/ca.crt`), material.owner);
    replaceRuntimeCredential(`${root}/runtime.json`, descriptor, material.owner);
  } catch (error) { clearApiIdentityMigration(component); throw error; }
  finally { material.clear(); key?.fill(0); descriptor?.fill(0); }
}

export function clearApiIdentityMigration(component: ComponentRelease) {
  if (!requiresApiIdentityMigration(component) || !directory(false)) return;
  for (const name of names) if (existsSync(`${root}/${name}`)) unlinkSync(`${root}/${name}`);
}

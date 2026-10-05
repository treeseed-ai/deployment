import { existsSync } from 'node:fs';
import { hostConfigurationSchema, type HostConfiguration } from '@treeseed/sdk/deployment';
import { componentCredential } from '../core/component-credential.js';
import { ensurePostgresAllocationCredentials } from '../postgres/credentials.js';
import type { PostgresInspectionSession } from '../postgres/inventory.js';
import { ensureComponentCredential } from './component-sealed-write.js';

/** Only called after verified allocation custody, under the supervisor's
 * serialized lifecycle. The host contract fixes every encrypted file path.
 */
export async function preparePostgresCredentials(input: HostConfiguration, requirementId: string, session: PostgresInspectionSession) {
  const host = hostConfigurationSchema.parse(input);
  if (!host.postgres) throw new Error('Explicit PostgreSQL topology required');
  const allocation = host.postgres.allocations.find(item => item.requirementId === requirementId);
  if (!allocation) throw new Error('PostgreSQL allocation unavailable');
  const references = new Set([allocation.migrationCredentialReference, allocation.runtimeCredentialReference]);
  const record = (id: string) => {
    if (!references.has(id)) throw new Error('PostgreSQL credential is outside the allocation');
    const secret = componentCredential(host, id);
    if (secret.provider !== 'systemd-credential') throw new Error('PostgreSQL requires OS-sealed credentials');
    return secret;
  };
  for (const id of references) record(id);
  return ensurePostgresAllocationCredentials(host.postgres, requirementId, session, {
    exists: id => existsSync(record(id).reference),
    ensure: (id, generate) => { record(id); return ensureComponentCredential(host, id, generate); },
  });
}

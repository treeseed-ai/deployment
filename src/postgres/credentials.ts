import { randomBytes } from 'node:crypto';
import { postgresTopologySchema } from '@treeseed/sdk/deployment';
import { postgresAllocationId } from './plan.js';
import { postgresAllocationMarker, type PostgresInspectionSession } from './inventory.js';

/** Implemented by the privileged supervisor's fixed OS-sealed component store.
 * No plaintext or verifier is returned by this operation.
 */
export interface PostgresCredentialCustody {
  exists(reference: string): boolean;
  ensure(reference: string, generate: () => string): string;
}

export async function ensurePostgresAllocationCredentials(input: unknown, requirementId: string,
  session: PostgresInspectionSession, custody: PostgresCredentialCustody) {
  const topology = postgresTopologySchema.parse(input);
  const allocation = topology.allocations.find(item => item.requirementId === requirementId);
  if (!allocation || !topology.requirements.some(item => item.id === requirementId && item.enabled)) throw new Error('Enabled PostgreSQL allocation required');
  const marker = postgresAllocationMarker(postgresAllocationId(topology, requirementId));
  const entries = [
    { role: allocation.migrationRole, reference: allocation.migrationCredentialReference },
    { role: allocation.runtimeRole, reference: allocation.runtimeCredentialReference },
  ];
  try {
    await session.query('BEGIN');
    await session.query("SET LOCAL lock_timeout = '5s'");
    await session.query('SELECT pg_advisory_xact_lock(1953654116, 1885823857)');
    const observed = await session.query(`SELECT rolname AS name, rolpassword IS NOT NULL AS initialized,
      shobj_description(oid, 'pg_authid') = $2 AS owned,
      NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS bounded
      FROM pg_authid WHERE rolname = ANY($1::text[])`, [entries.map(item => item.role), marker]);
    // Check every role before writing any record. Missing custody must never
    // silently replace an already initialized database password.
    for (const entry of entries) {
      const role = observed.rows.find(row => row.name === entry.role);
      if (!role || role.owned !== true || role.bounded !== true || typeof role.initialized !== 'boolean') throw new Error();
      if (role.initialized && !custody.exists(entry.reference)) throw new Error();
    }
    for (const entry of entries) {
      const password = custody.ensure(entry.reference, () => randomBytes(32).toString('base64url'));
      if (!/^[A-Za-z0-9_-]{32,128}$/u.test(password)) throw new Error();
    }
    await session.query('COMMIT');
    return { requirementId, credentialsReady: true as const };
  } catch {
    await session.query('ROLLBACK').catch(() => undefined);
    throw new Error('PostgreSQL credential custody is unavailable or conflicts with initialized roles; restore custody before activation.');
  }
}

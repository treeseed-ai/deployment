import { postgresTopologySchema } from '@treeseed/sdk/deployment';
import { postgresAllocationId } from './plan.js';
import { postgresAllocationMarker, type PostgresInspectionSession } from './inventory.js';

/** Failure/recovery gate for exactly the allocation's two login roles. Owner
 * and unrelated sessions are never terminated. New logins are denied first.
 */
export async function disablePostgresAllocation(input: unknown, requirementId: string, session: PostgresInspectionSession) {
  const topology = postgresTopologySchema.parse(input);
  const allocation = topology.allocations.find(item => item.requirementId === requirementId);
  if (!allocation) throw new Error('PostgreSQL allocation required');
  const roles = [allocation.migrationRole, allocation.runtimeRole];
  const marker = postgresAllocationMarker(postgresAllocationId(topology, requirementId));
  try {
    await session.query('BEGIN');
    await session.query("SET LOCAL lock_timeout='5s'");
    await session.query('SELECT pg_advisory_xact_lock(1953654116, 1885823857)');
    const custody = await session.query(`SELECT count(*)=2 AS owned FROM pg_roles WHERE rolname=ANY($1::text[])
      AND shobj_description(oid,'pg_authid')=$2 AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)`, [roles, marker]);
    if (custody.rows.length !== 1 || custody.rows[0]?.owned !== true) throw new Error();
    for (const role of roles) await session.query(`ALTER ROLE "${role}" NOLOGIN`);
    await session.query('COMMIT');
    await session.query('SELECT pg_terminate_backend(pid, 5000) FROM pg_stat_activity WHERE usename=ANY($1::text[]) AND pid<>pg_backend_pid()', [roles]);
    const remaining = await session.query('SELECT NOT EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename=ANY($1::text[])) AS drained', [roles]);
    if (remaining.rows.length !== 1 || remaining.rows[0]?.drained !== true) throw new Error();
    return { requirementId, disabled: true as const };
  } catch {
    await session.query('ROLLBACK').catch(() => undefined);
    throw new Error('PostgreSQL allocation disable could not be verified; recovery is required');
  }
}

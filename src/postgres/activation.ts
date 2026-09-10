import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { postgresTopologySchema } from '@treeseed/sdk/deployment';
import { postgresAllocationId } from './plan.js';
import { postgresAllocationMarker, type PostgresInspectionSession } from './inventory.js';
import { postgresRuntimeAccessSql } from './access.js';
import { verifyPostgresRuntimeAccess } from './verify.js';

/** Matches PostgreSQL's SCRAM verifier format. Only generated ASCII passwords
 * are accepted; human passwords require SASLprep and are not this interface.
 * https://www.postgresql.org/docs/17/sql-createrole.html
 */
export function postgresPasswordVerifier(password: string): string {
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(password)) throw new Error('A generated PostgreSQL credential is required');
  const salt = randomBytes(16), iterations = 16384;
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const client = createHmac('sha256', salted).update('Client Key').digest();
  const stored = createHash('sha256').update(client).digest('base64');
  const server = createHmac('sha256', salted).update('Server Key').digest('base64');
  salted.fill(0); client.fill(0);
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${stored}:${server}`;
}

/** The caller supplies a fresh TLS-verified bootstrap session in the allocated
 * database and a generated password from protected custody. Never return it.
 * Writers must be stopped; this operation does not terminate user connections.
 */
export async function activatePostgresAllocation(input: unknown, requirementId: string,
  phase: 'migration' | 'runtime', password: string, session: PostgresInspectionSession) {
  const topology = postgresTopologySchema.parse(input);
  const allocation = topology.allocations.find(item => item.requirementId === requirementId);
  const requirement = topology.requirements.find(item => item.id === requirementId);
  if (!allocation || !requirement?.enabled || !['migration', 'runtime'].includes(phase)) throw new Error('Invalid PostgreSQL activation');
  const verifier = postgresPasswordVerifier(password);
  const marker = postgresAllocationMarker(postgresAllocationId(topology, requirementId));
  const quote = (name: string) => `"${name}"`;
  const owner = quote(allocation.ownerRole), migration = quote(allocation.migrationRole), runtime = quote(allocation.runtimeRole);
  try {
    await session.query('BEGIN');
    await session.query("SET LOCAL lock_timeout = '5s'");
    await session.query('SELECT pg_advisory_xact_lock(1953654116, 1885823857)');
    const custody = await session.query(`SELECT
      current_database() = $1 AND EXISTS (SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba
        WHERE d.datname=current_database() AND r.rolname=$2 AND shobj_description(d.oid,'pg_database')=$3) AS owned,
      (SELECT count(*)=3 FROM pg_roles WHERE rolname=ANY($4::text[]) AND shobj_description(oid,'pg_authid')=$3
        AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) AS roles,
      NOT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()) AS idle,
      NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles member ON member.oid=m.member JOIN pg_roles role ON role.oid=m.roleid
        WHERE member.rolname=ANY($4::text[]) AND NOT (member.rolname=$5 AND role.rolname=$2 AND NOT m.admin_option)) AS memberships`,
    [allocation.database, allocation.ownerRole, marker, [allocation.ownerRole, allocation.migrationRole, allocation.runtimeRole], allocation.migrationRole]);
    if (['owned', 'roles', 'idle', 'memberships'].some(key => custody.rows.length !== 1 || custody.rows[0]?.[key] !== true)) throw new Error('PostgreSQL activation custody or writer conflict');
    // Suppress standard statement/error/slow-query logging before sending even
    // a verifier. The managed server has no third-party auditing extensions.
    const logging = await session.query("SELECT current_setting('shared_preload_libraries') AS shared, current_setting('session_preload_libraries') AS session, current_setting('local_preload_libraries') AS local");
    if (['shared', 'session', 'local'].some(key => logging.rows[0]?.[key] !== '')) throw new Error('PostgreSQL logging policy requires explicit adapter support');
    await session.query("SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic'; SET LOCAL log_min_duration_statement=-1; SET LOCAL log_min_duration_sample=-1; SET LOCAL log_transaction_sample_rate=0; SET LOCAL log_duration=off");
    await session.query(`ALTER ROLE ${migration} NOLOGIN; ALTER ROLE ${runtime} NOLOGIN`);
    await session.query(postgresRuntimeAccessSql(allocation));
    if (phase === 'migration') {
      // Trusted extensions belong to the application owner, not the host
      // administrator. pg_restore restores their comments as that same owner.
      // PostgreSQL still rejects untrusted extensions for this restricted role.
      await session.query(`SET LOCAL ROLE ${owner}`);
      for (const extension of requirement.extensions) await session.query(`CREATE EXTENSION IF NOT EXISTS ${quote(extension)} WITH SCHEMA public`);
      await session.query('RESET ROLE');
      await session.query(`GRANT ${owner} TO ${migration}; ALTER ROLE ${migration} SET role = '${allocation.ownerRole}'`);
      await session.query(`ALTER ROLE ${migration} LOGIN CONNECTION LIMIT 4 PASSWORD '${verifier}'`);
    } else {
      await session.query(`ALTER ROLE ${runtime} RESET ALL`);
      await session.query(`ALTER ROLE ${runtime} LOGIN CONNECTION LIMIT ${requirement.runtimeConnectionLimit} PASSWORD '${verifier}'`);
      if (!(await verifyPostgresRuntimeAccess(allocation, session)).verified) throw new Error('PostgreSQL runtime permissions failed');
    }
    await session.query('COMMIT');
    return { requirementId, phase, activated: true as const };
  } catch {
    await session.query('ROLLBACK').catch(() => undefined);
    throw new Error('PostgreSQL activation failed; check custody, stopped writers and server logging policy.');
  }
}

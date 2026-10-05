import { createHash, createHmac, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import { postgresTopologySchema } from '@treeseed/sdk/deployment';
import { postgresAllocationId } from './plan.js';
import { postgresAllocationMarker, type PostgresInspectionSession } from './inventory.js';
import { verifyPostgresRuntimeAccess } from './verify.js';

/** Bounded comparison against an internal catalog verifier. Never export the
 * verifier through receipts, diagnostics or caller-facing state.
 */
export function postgresPasswordMatches(password: string, verifier: unknown): boolean {
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(password) || typeof verifier !== 'string') return false;
  const match = /^SCRAM-SHA-256\$(\d{1,6}):([A-Za-z0-9+/=]{8,128})\$([A-Za-z0-9+/=]{44}):([A-Za-z0-9+/=]{44})$/u.exec(verifier);
  if (!match || Number(match[1]) < 4096 || Number(match[1]) > 262144) return false;
  const stored = Buffer.from(match[3]!, 'base64'), server = Buffer.from(match[4]!, 'base64');
  if (stored.length !== 32 || server.length !== 32) return false;
  const salted = pbkdf2Sync(password, Buffer.from(match[2]!, 'base64'), Number(match[1]), 32, 'sha256');
  const client = createHmac('sha256', salted).update('Client Key').digest();
  const expectedStored = createHash('sha256').update(client).digest();
  const expectedServer = createHmac('sha256', salted).update('Server Key').digest();
  try { return timingSafeEqual(stored, expectedStored) && timingSafeEqual(server, expectedServer); }
  finally { salted.fill(0); client.fill(0); expectedStored.fill(0); expectedServer.fill(0); }
}

/** Read-only check with active application writers allowed. No role mutation,
 * reconnect, password rotation or schema migration is needed for a healthy noop.
 */
export async function verifyPostgresAllocationRuntime(input: unknown, requirementId: string, password: string, session: PostgresInspectionSession) {
  const topology = postgresTopologySchema.parse(input);
  const allocation = topology.allocations.find(item => item.requirementId === requirementId);
  const requirement = topology.requirements.find(item => item.id === requirementId);
  if (!allocation || !requirement?.enabled) throw new Error('Enabled PostgreSQL runtime allocation required');
  const marker = postgresAllocationMarker(postgresAllocationId(topology, requirementId));
  try {
    await session.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const access = await verifyPostgresRuntimeAccess(allocation, session);
    const result = await session.query(`SELECT
      (SELECT rolpassword FROM pg_authid WHERE rolname=$1) AS verifier,
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname=$1 AND rolconnlimit=$2 AND rolvaliduntil IS NULL AND rolconfig IS NULL) AS limits,
      (SELECT count(*)=3 FROM pg_roles WHERE rolname=ANY($3::text[]) AND shobj_description(oid,'pg_authid')=$4
        AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) AS custody,
      EXISTS (SELECT 1 FROM pg_database WHERE datname=current_database() AND shobj_description(oid,'pg_database')=$4 AND datallowconn) AS database,
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname=$5 AND NOT rolcanlogin) AS "migratorDisabled",
      NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
        AND (NOT has_table_privilege($1,c.oid,'SELECT') OR NOT has_table_privilege($1,c.oid,'INSERT') OR NOT has_table_privilege($1,c.oid,'UPDATE') OR NOT has_table_privilege($1,c.oid,'DELETE')
          OR has_table_privilege($1,c.oid,'TRUNCATE') OR has_table_privilege($1,c.oid,'REFERENCES') OR has_table_privilege($1,c.oid,'TRIGGER'))) AS tables,
      NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S'
        AND (NOT has_sequence_privilege($1,c.oid,'USAGE') OR NOT has_sequence_privilege($1,c.oid,'SELECT') OR has_sequence_privilege($1,c.oid,'UPDATE'))) AS sequences,
      NOT EXISTS (SELECT 1 FROM pg_database WHERE NOT datistemplate AND datname NOT IN (current_database(),'postgres')
        AND has_database_privilege($1,oid,'CONNECT')) AS isolation,
      NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles member ON member.oid=m.member JOIN pg_roles granted ON granted.oid=m.roleid
        WHERE member.rolname=ANY($3::text[]) AND NOT (member.rolname=$5 AND granted.rolname=$6 AND NOT m.admin_option)) AS memberships`,
    [allocation.runtimeRole, requirement.runtimeConnectionLimit, [allocation.ownerRole, allocation.migrationRole, allocation.runtimeRole], marker, allocation.migrationRole, allocation.ownerRole]);
    const row = result.rows[0];
    const blockers = [...access.blockers, ...['limits', 'custody', 'database', 'migratorDisabled', 'tables', 'sequences', 'isolation', 'memberships'].filter(key => result.rows.length !== 1 || row?.[key] !== true)];
    if (!postgresPasswordMatches(password, row?.verifier)) blockers.push('credentialMismatch');
    if (row) delete row.verifier;
    const defaults = await session.query(`SELECT owner.rolname AS owner, d.defaclobjtype AS kind,
      CASE WHEN d.defaclnamespace=0 THEN 'global' ELSE n.nspname END AS scope,
      CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE recipient.rolname END AS recipient,
      a.privilege_type AS privilege, a.is_grantable AS grantable
      FROM pg_default_acl d JOIN pg_roles owner ON owner.oid=d.defaclrole
      LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
      CROSS JOIN LATERAL aclexplode(d.defaclacl) a LEFT JOIN pg_roles recipient ON recipient.oid=a.grantee
      WHERE owner.rolname=ANY($1::text[]) AND d.defaclobjtype IN ('r','S')
        AND (a.grantee=0 OR recipient.rolname=$2)`, [[allocation.ownerRole, allocation.migrationRole], allocation.runtimeRole]);
    const expected = new Set([allocation.ownerRole, allocation.migrationRole].flatMap(owner =>
      [['r', ['SELECT', 'INSERT', 'UPDATE', 'DELETE']], ['S', ['USAGE', 'SELECT']]] .flatMap(([kind, privileges]) =>
        (privileges as string[]).map(privilege => `${owner}:${kind}:${privilege}`))));
    let unsafeDefaults = false;
    for (const entry of defaults.rows) {
      const key = `${entry.owner}:${entry.kind}:${entry.privilege}`;
      if (entry.scope !== 'public' || entry.recipient !== allocation.runtimeRole || entry.grantable !== false || !expected.delete(key)) unsafeDefaults = true;
    }
    if (unsafeDefaults || expected.size) blockers.push('defaultPrivileges');
    await session.query('COMMIT');
    return { requirementId, verified: blockers.length === 0, action: blockers.length ? 'repair-required' as const : 'noop' as const, blockers };
  } catch {
    await session.query('ROLLBACK').catch(() => undefined);
    throw new Error('PostgreSQL runtime verification unavailable');
  }
}

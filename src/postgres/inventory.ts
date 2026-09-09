import type { PostgresInventory } from './plan.js';
import { readPendingMarker } from './intent.js';

/** A single authenticated, TLS-verified bootstrap connection supplied by Deployment. */
export interface PostgresInspectionSession {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** No passwords or credential catalog columns are selected. */
export async function inspectPostgresAllocations(serverId: string, session: PostgresInspectionSession): Promise<PostgresInventory> {
  try {
    await session.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const version = await session.query("SELECT current_setting('server_version_num')::integer AS version");
    const extensions = await session.query('SELECT name FROM pg_available_extensions ORDER BY name');
    const databases = await session.query(`SELECT d.datname AS name, r.rolname AS owner, d.datallowconn AS "allowConnections",
      shobj_description(d.oid, 'pg_database') AS marker
      FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba ORDER BY d.datname`);
    const roles = await session.query(`SELECT rolname AS name, rolsuper AS superuser,
      rolcreatedb AS "createDatabase", rolcreaterole AS "createRole",
      rolreplication AS replication, rolbypassrls AS "bypassRls",
      rolcanlogin AS login, EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid=r.oid OR m.member=r.oid) AS memberships,
      shobj_description(oid, 'pg_authid') AS marker FROM pg_roles r ORDER BY rolname`);
    const numericVersion = Number(version.rows[0]?.version);
    if (!Number.isInteger(numericVersion) || numericVersion < 140000) throw new Error('Unsupported PostgreSQL inventory version');
    const result: PostgresInventory = {
      serverId, major: Math.floor(numericVersion / 10000),
      extensions: extensions.rows.map(row => requiredString(row.name)),
      databases: databases.rows.map(row => ({ name: requiredString(row.name), owner: requiredString(row.owner), allocationId: allocationMarker(row.marker), allowConnections: requiredBoolean(row.allowConnections) })),
      roles: roles.rows.map(row => ({ name: requiredString(row.name), allocationId: readPendingMarker(row.marker)?.allocationId ?? allocationMarker(row.marker),
        ...(readPendingMarker(row.marker) ? { pendingDigest: readPendingMarker(row.marker)!.intentDigest } : {}),
        login: requiredBoolean(row.login), memberships: requiredBoolean(row.memberships),
        superuser: requiredBoolean(row.superuser), createDatabase: requiredBoolean(row.createDatabase),
        createRole: requiredBoolean(row.createRole), replication: requiredBoolean(row.replication), bypassRls: requiredBoolean(row.bypassRls) })),
    };
    await session.query('COMMIT');
    return result;
  } catch {
    await session.query('ROLLBACK').catch(() => undefined);
    // Driver errors may contain connection options; never propagate them to receipts.
    throw new Error('PostgreSQL allocation inspection failed');
  }
}

export function postgresAllocationMarker(allocationId: string): string {
  return JSON.stringify({ schemaVersion: 'treeseed.postgres-allocation/v1', allocationId });
}

function allocationMarker(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed?.schemaVersion === 'treeseed.postgres-allocation/v1' && typeof parsed.allocationId === 'string'
      && parsed.allocationId.length > 0 ? parsed.allocationId : null;
  } catch { return null; }
}
function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Invalid PostgreSQL inventory');
  return value;
}
function requiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid PostgreSQL inventory');
  return value;
}

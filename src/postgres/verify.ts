import { postgresAllocationSchema } from '@treeseed/sdk/deployment';
import type { PostgresInspectionSession } from './inventory.js';

/** Recheck live permissions after provisioning, migration or restoration. No credential reads. */
export async function verifyPostgresRuntimeAccess(input: unknown, session: PostgresInspectionSession) {
  const allocation = postgresAllocationSchema.parse(input);
  // Schema validation restricts identifiers to lowercase ASCII SQL names.
  const result = await session.query(`SELECT
    current_database() = '${allocation.database}' AS "correctDatabase",
    EXISTS (SELECT 1 FROM pg_database d JOIN pg_roles o ON o.oid=d.datdba
      WHERE d.datname=current_database() AND o.rolname='${allocation.ownerRole}' AND NOT o.rolcanlogin) AS "isolatedOwner",
    EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname='${allocation.runtimeRole}'
      AND r.rolcanlogin AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)) AS "restrictedRuntime",
    has_database_privilege('${allocation.runtimeRole}',current_database(),'CONNECT') AS "canConnect",
    NOT has_database_privilege('${allocation.runtimeRole}',current_database(),'CREATE') AS "cannotCreateSchemas",
    has_schema_privilege('${allocation.runtimeRole}','public','USAGE') AS "canUseSchema",
    NOT has_schema_privilege('${allocation.runtimeRole}','public','CREATE') AS "cannotCreateTables",
    NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='public' AND r.rolname='${allocation.runtimeRole}') AS "doesNotOwnObjects"`);
  const expected = ['correctDatabase', 'isolatedOwner', 'restrictedRuntime', 'canConnect', 'cannotCreateSchemas', 'canUseSchema', 'cannotCreateTables', 'doesNotOwnObjects'];
  const blockers = expected.filter(key => result.rows.length !== 1 || result.rows[0]?.[key] !== true);
  return { verified: blockers.length === 0, blockers };
}

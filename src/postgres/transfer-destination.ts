import { deploymentDigest, postgresTopologySchema } from '@treeseed/sdk/deployment';
import { postgresAllocationId } from './plan.js';
import { postgresAllocationMarker, type PostgresInspectionSession } from './inventory.js';
import { postgresTransferLocaleSchema } from './transfer-locale.js';
import { transferUnsupportedSql } from './transfer-catalog.js';

/** Inspect an already-allocated destination through the owner's protected
 * bootstrap connection. Never adopt a same-named database or return verifiers.
 * Import login may be enabled only inside the fenced restore phase.
 */
export async function inspectPostgresTransferDestination(input: unknown, requirementId: string,
  session: PostgresInspectionSession, importing = false) {
  const topology = postgresTopologySchema.parse(input);
  const allocation = topology.allocations.find(item => item.requirementId === requirementId);
  const requirement = topology.requirements.find(item => item.id === requirementId);
  if (!allocation || !requirement?.enabled) throw new Error('Enabled PostgreSQL transfer allocation required');
  const server = topology.servers.find(item => item.id === allocation.serverId)!;
  const marker = postgresAllocationMarker(postgresAllocationId(topology, requirementId));
  try {
    await session.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await session.query('SET LOCAL search_path=pg_catalog');
    if ((await session.query(transferUnsupportedSql)).rows[0]?.unsupported !== false) throw new Error();
    const result = await session.query(`SELECT d.datname AS database,
      current_setting('server_version_num')::int/10000 AS major,
      (SELECT system_identifier::text FROM pg_control_system()) AS cluster,
      pg_get_userbyid(d.datdba)=$2 AND shobj_description(d.oid,'pg_database')=$3 AND d.datallowconn AS owned,
      jsonb_build_object('encoding',pg_encoding_to_char(d.encoding),'collate',d.datcollate,'ctype',d.datctype,
        'provider',d.datlocprovider,'version',d.datcollversion,'locale',COALESCE(to_jsonb(d)->>'datlocale',to_jsonb(d)->>'daticulocale')) AS locale,
      (SELECT count(*)=3 FROM pg_roles WHERE rolname=ANY($4::text[]) AND shobj_description(oid,'pg_authid')=$3
        AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
        AND (NOT rolcanlogin OR ($7 AND rolname=$5))) AS roles,
      NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles member ON member.oid=m.member JOIN pg_roles granted ON granted.oid=m.roleid
        WHERE member.rolname=ANY($4::text[]) AND NOT (member.rolname=$5 AND granted.rolname=$2 AND NOT m.admin_option)) AS memberships,
      NOT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend') AS idle,
      NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname NOT IN ('public','pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%')
        AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
          AND NOT EXISTS (SELECT 1 FROM pg_depend x WHERE x.classid='pg_class'::regclass AND x.objid=c.oid AND x.deptype='e'))
        AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
          AND NOT EXISTS (SELECT 1 FROM pg_depend x WHERE x.classid='pg_proc'::regclass AND x.objid=p.oid AND x.deptype='e'))
        AND NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'
          AND NOT EXISTS (SELECT 1 FROM pg_depend x WHERE x.classid='pg_type'::regclass AND x.objid=t.oid AND x.deptype='e'))
        AND NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname<>'plpgsql' AND NOT extname=ANY($6::text[])) AS empty
      FROM pg_database d WHERE d.datname=current_database() AND d.datname=$1`,
    [allocation.database, allocation.ownerRole, marker, [allocation.ownerRole,allocation.migrationRole,allocation.runtimeRole],
      allocation.migrationRole, requirement.extensions, importing]);
    const row = result.rows[0];
    if (result.rows.length !== 1 || row?.database !== allocation.database || row.major !== server.major ||
      typeof row.cluster !== 'string' || !/^[0-9]{1,20}$/u.test(row.cluster) ||
      ['owned','roles','memberships','idle'].some(key => row[key] !== true) || typeof row.empty !== 'boolean') throw new Error();
    const identity = { database: allocation.database, major: server.major,
      clusterIdentity: deploymentDigest({ cluster: row.cluster }), locale: postgresTransferLocaleSchema.parse(row.locale),
      allocationDigest: deploymentDigest({ installationId: topology.installationId, environment: topology.environment, allocation, requirement, server }) };
    await session.query('COMMIT');
    return { ...identity, empty: row.empty, inventoryDigest: deploymentDigest(identity) };
  } catch {
    await session.query('ROLLBACK').catch(() => undefined);
    throw new Error('PostgreSQL destination custody or idle state is unverified; existing data unchanged');
  }
}

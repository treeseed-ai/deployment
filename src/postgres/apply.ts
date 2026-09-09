import { postgresTopologySchema } from '@treeseed/sdk/deployment';
import { inspectPostgresAllocations, postgresAllocationMarker, type PostgresInspectionSession } from './inventory.js';
import { planPostgresAllocations, postgresAllocationId } from './plan.js';

type Plan = ReturnType<typeof planPostgresAllocations>;

/** Dedicated bootstrap sessions, connected to the selected servers' postgres databases.
 * This phase creates custody only. All roles remain NOLOGIN; credential/migration
 * activation is a separate gate. Never drop resources as rollback.
 */
export async function applyPostgresAllocations(input: unknown, expected: Pick<Plan, 'topologyDigest' | 'inventoryDigest'>,
  sessions: ReadonlyMap<string, PostgresInspectionSession>) {
  const topology = postgresTopologySchema.parse(input);
  const enabled = topology.allocations.filter(allocation => topology.requirements.find(item => item.id === allocation.requirementId)!.enabled);
  const serverIds = [...new Set(enabled.map(allocation => allocation.serverId))].sort();
  const locked: PostgresInspectionSession[] = [];
  try {
    for (const id of serverIds) {
      const session = sessions.get(id);
      if (!session) throw new Error('Missing PostgreSQL bootstrap session');
      const identity = await session.query("SELECT current_database() = 'postgres' AS bootstrap");
      if (identity.rows[0]?.bootstrap !== true) throw new Error('Invalid PostgreSQL bootstrap database');
      // One lock across all TreeSeed installations sharing a physical server.
      const lock = await session.query('SELECT pg_try_advisory_lock(1953654116, 1885823857) AS locked');
      if (lock.rows[0]?.locked !== true) throw new Error('PostgreSQL allocation busy');
      locked.push(session);
    }
    const observed = await Promise.all(serverIds.map(id => inspectPostgresAllocations(id, sessions.get(id)!)));
    const plan = planPostgresAllocations(topology, observed);
    if (!plan.ready || plan.topologyDigest !== expected.topologyDigest || plan.inventoryDigest !== expected.inventoryDigest) {
      throw new Error('PostgreSQL allocation plan is blocked or stale');
    }
    const created: string[] = [];
    for (const action of plan.actions) {
      if (action.action !== 'create') continue;
      const allocation = topology.allocations.find(item => item.requirementId === action.requirementId)!;
      const session = sessions.get(allocation.serverId)!;
      const quote = (name: string) => `"${name}"`; // SDK validates every identifier.
      const marker = postgresAllocationMarker(postgresAllocationId(topology, allocation.requirementId)).replaceAll("'", "''");
      const owner = quote(allocation.ownerRole), database = quote(allocation.database);
      // Roles and ownership markers are atomic. Any unexpected partial custody
      // on a subsequent run stays blocked rather than being adopted or deleted.
      await transaction(session, async () => {
        for (const role of [allocation.ownerRole, allocation.migrationRole, allocation.runtimeRole]) {
          await session.query(`CREATE ROLE ${quote(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
          await session.query(`COMMENT ON ROLE ${quote(role)} IS '${marker}'`);
        }
      });
      // PostgreSQL cannot CREATE DATABASE inside a transaction. Initially deny
      // connections so interruption cannot expose an unconfigured database.
      await session.query(`CREATE DATABASE ${database} OWNER ${owner} TEMPLATE template0 ALLOW_CONNECTIONS false`);
      await transaction(session, async () => {
        await session.query(`COMMENT ON DATABASE ${database} IS '${marker}'`);
        await session.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
        await session.query(`ALTER DATABASE ${database} ALLOW_CONNECTIONS true`);
      });
      created.push(allocation.requirementId);
    }
    const after = await Promise.all(serverIds.map(id => inspectPostgresAllocations(id, sessions.get(id)!)));
    const verified = planPostgresAllocations(topology, after);
    if (!verified.ready || verified.actions.some(action => action.action === 'create')) throw new Error('PostgreSQL custody read-back failed');
    return { schemaVersion: 'treeseed.postgres-custody-result/v1' as const, created,
      topologyDigest: verified.topologyDigest, inventoryDigest: verified.inventoryDigest,
      activationRequired: enabled.map(item => item.requirementId) };
  } catch {
    // Do not serialize driver diagnostics/connection options into host receipts.
    throw new Error('PostgreSQL allocation failed; re-plan against current inventory. Existing data was preserved.');
  } finally {
    for (const session of locked.reverse()) {
      await session.query('SELECT pg_advisory_unlock(1953654116, 1885823857)').catch(() => undefined);
    }
  }
}

async function transaction(session: PostgresInspectionSession, run: () => Promise<void>) {
  await session.query('BEGIN');
  try { await run(); await session.query('COMMIT'); }
  catch (error) { await session.query('ROLLBACK').catch(() => undefined); throw error; }
}

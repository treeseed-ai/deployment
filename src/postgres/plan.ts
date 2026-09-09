import { createHash } from 'node:crypto';
import { postgresTopologySchema, type PostgresTopology } from '@treeseed/sdk/deployment';
export { inspectPostgresAllocations, postgresAllocationMarker, type PostgresInspectionSession } from './inventory.js';
export { postgresRuntimeAccessSql } from './access.js';
export { verifyPostgresRuntimeAccess } from './verify.js';
export { withManagedPostgresSession } from './connection.js';

export interface PostgresInventory {
  serverId: string;
  major: number;
  extensions: string[];
  databases: Array<{ name: string; owner: string; allocationId: string | null }>;
  roles: Array<{ name: string; superuser: boolean; createDatabase: boolean; createRole: boolean; replication: boolean; bypassRls: boolean; allocationId: string | null }>;
}

/** Read-only planning. Never adopts unmarked existing data or removes disabled data. */
export function planPostgresAllocations(input: unknown, observed: PostgresInventory[]) {
  const topology = postgresTopologySchema.parse(input);
  const blockers: string[] = [];
  const actions: Array<{ requirementId: string; serverId: string; database: string; action: 'create' | 'verify' | 'retain' }> = [];
  if (new Set(observed.map(server => server.serverId)).size !== observed.length) throw new Error('Duplicate PostgreSQL server inventory');
  for (const allocation of topology.allocations) {
    const requirement = topology.requirements.find(item => item.id === allocation.requirementId)!;
    if (!requirement.enabled) {
      actions.push({ requirementId: requirement.id, serverId: allocation.serverId, database: allocation.database, action: 'retain' });
      continue;
    }
    const server = observed.find(item => item.serverId === allocation.serverId);
    if (!server) { blockers.push(`${requirement.id}:server-unobserved`); continue; }
    const selected = topology.servers.find(item => item.id === server.serverId)!;
    if (server.major !== selected.major || requirement.extensions.some(extension => !server.extensions.includes(extension))) {
      blockers.push(`${requirement.id}:server-requirements-mismatch`); continue;
    }
    const allocationId = postgresAllocationId(topology, requirement.id);
    const database = server.databases.find(item => item.name === allocation.database);
    const names = [allocation.ownerRole, allocation.migrationRole, allocation.runtimeRole];
    const roles = server.roles.filter(item => names.includes(item.name));
    if (database && (database.owner !== allocation.ownerRole || database.allocationId !== allocationId) ||
        roles.some(role => role.allocationId !== allocationId || role.superuser || role.createDatabase || role.createRole || role.replication || role.bypassRls)) {
      blockers.push(`${requirement.id}:existing-custody-conflict`); continue;
    }
    if (database || roles.length) {
      // Incomplete or drifted allocations require explicit repair, not silent takeover.
      if (!database || roles.length !== 3) { blockers.push(`${requirement.id}:partial-allocation`); continue; }
      // Custody alone cannot prove grants, credential versions or connection
      // limits. Require full access read-back before a reconciler may emit noop.
      actions.push({ requirementId: requirement.id, serverId: allocation.serverId, database: allocation.database, action: 'verify' });
    } else actions.push({ requirementId: requirement.id, serverId: allocation.serverId, database: allocation.database, action: 'create' });
  }
  return { schemaVersion: 'treeseed.postgres-plan/v1' as const, ready: blockers.length === 0, blockers, actions,
    inventoryDigest: createHash('sha256').update(JSON.stringify(observed)).digest('hex') };
}

export function postgresAllocationId(topology: PostgresTopology, requirementId: string) {
  return `${topology.installationId}:${topology.environment}:${requirementId}`;
}

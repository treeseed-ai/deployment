import { verifyHostPostgresRequirements, type ComponentRelease, type HostConfiguration } from '@treeseed/sdk/deployment';
import { loadHostConfiguration } from '../core/configuration.js';
import { withLocalPostgresBootstrap } from '../postgres/connection.js';
import { applyPostgresAllocations, inspectPostgresAllocations, planPostgresAllocations } from '../postgres/plan.js';
import { installedComponentRelease } from './component-release.js';
import { preparePostgresCredentials } from './postgres-credentials.js';

export function localPostgresTopology(host: HostConfiguration, releases: ComponentRelease[]) {
  verifyHostPostgresRequirements(host, releases);
  const topology = host.postgres;
  if (!topology || !host.components.postgres?.enabled || topology.servers.length !== 1) throw new Error('One enabled local PostgreSQL server is required');
  const server = topology.servers[0]!;
  if (server.mode !== 'shared' || server.hostname !== 'postgres' || server.port !== 5432) throw new Error('This operation requires the managed local PostgreSQL server; external routing is not supported');
  return topology;
}

/** Fixed root socket and installed release custody, never caller SQL, server
 * addresses, passwords or arbitrary file paths. Application login is separate.
 */
export async function reconcileLocalPostgres(selections: Array<{ componentId: string; release: string }>,
  expected?: { topologyDigest: string; inventoryDigest: string }) {
  const host = loadHostConfiguration();
  const releases = selections.map(item => installedComponentRelease(item.componentId, item.release));
  const topology = localPostgresTopology(host, releases);
  const serverId = topology.servers[0]!.id;
  return withLocalPostgresBootstrap('/run/treeseed/postgres/socket', 'postgres', async session => {
    if (!expected) return planPostgresAllocations(topology, [await inspectPostgresAllocations(serverId, session)]);
    const result = await applyPostgresAllocations(topology, expected, new Map([[serverId, session]]));
    for (const requirementId of result.activationRequired) await preparePostgresCredentials(host, requirementId, session);
    return { ...result, credentialsReady: true };
  });
}

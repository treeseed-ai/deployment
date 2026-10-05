import { deploymentDigest, type PostgresTopology } from '@treeseed/sdk/deployment';

/** Pending role custody is the durable intent across CREATE DATABASE, which
 * PostgreSQL cannot include in the role/marker transaction. No secret values.
 */
export function postgresAllocationIntent(topology: PostgresTopology, requirementId: string) {
  const allocation = topology.allocations.find(item => item.requirementId === requirementId);
  const requirement = topology.requirements.find(item => item.id === requirementId);
  if (!allocation || !requirement) throw new Error('Missing PostgreSQL allocation intent');
  const server = topology.servers.find(item => item.id === allocation.serverId);
  return deploymentDigest({ installationId: topology.installationId, environment: topology.environment,
    componentId: requirement.componentId, allocation, server });
}

export function postgresPendingMarker(allocationId: string, intentDigest: string) {
  return JSON.stringify({ schemaVersion: 'treeseed.postgres-allocation-intent/v1', allocationId, intentDigest });
}

export function readPendingMarker(value: unknown): { allocationId: string; intentDigest: string } | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed.schemaVersion === 'treeseed.postgres-allocation-intent/v1' && typeof parsed.allocationId === 'string'
      && parsed.allocationId.length > 0 && /^sha256:[a-f0-9]{64}$/u.test(parsed.intentDigest)
      ? { allocationId: parsed.allocationId, intentDigest: parsed.intentDigest } : null;
  } catch { return null; }
}

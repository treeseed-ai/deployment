import { expect, it, vi } from 'vitest';
import { applyPostgresAllocations, planPostgresAllocations } from '../src/postgres/plan.js';

const topology = {
  schemaVersion: 'treeseed.postgres-topology/v1', installationId: 'test', environment: 'staging',
  servers: [{ id: 'shared', installationId: 'test', environment: 'staging', mode: 'shared', hostname: 'postgres', port: 5432, major: 17, extensions: [], tls: { mode: 'verify-full', trustReference: 'postgres-ca' } }],
  requirements: [{ id: 'api', componentId: 'api', enabled: true, supportedMajors: [17], extensions: [], runtimeConnectionLimit: 10 }],
  allocations: [{ requirementId: 'api', serverId: 'shared', database: 'api', ownerRole: 'api_owner', migrationRole: 'api_migrator', runtimeRole: 'api_runtime', migrationCredentialReference: 'api-migration', runtimeCredentialReference: 'api-runtime', onDisable: 'preserve' }],
};
it('retains disabled applications without a server connection', async () => {
  const disabled = { ...topology, requirements: [{ ...topology.requirements[0]!, enabled: false }] };
  const result = await applyPostgresAllocations(disabled, planPostgresAllocations(disabled, []), new Map());
  expect(result.created).toEqual([]);
  expect(result.activationRequired).toEqual([]);
});
it('rejects missing bootstrap sessions', async () => {
  await expect(applyPostgresAllocations(topology, { topologyDigest: '', inventoryDigest: '' }, new Map())).rejects.toThrow('allocation failed');
});
it('never allocates through an application database session', async () => {
  const query = vi.fn(async () => ({ rows: [{ bootstrap: false }] }));
  await expect(applyPostgresAllocations(topology, { topologyDigest: '', inventoryDigest: '' }, new Map([['shared', { query }]]))).rejects.toThrow('allocation failed');
  expect(query).toHaveBeenCalledTimes(1);
});
it('rejects concurrent allocation before any DDL and leaves another session lock alone', async () => {
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('current_database') ? [{ bootstrap: true }] : [{ locked: false }] }));
  await expect(applyPostgresAllocations(topology, { topologyDigest: '', inventoryDigest: '' }, new Map([['shared', { query }]]))).rejects.toThrow('allocation failed');
  expect(query).toHaveBeenCalledTimes(2);
});
it('redacts driver failures', async () => {
  const query = vi.fn(async () => { throw new Error('password=do-not-leak'); });
  await expect(applyPostgresAllocations(topology, { topologyDigest: '', inventoryDigest: '' }, new Map([['shared', { query }]]))).rejects.not.toThrow('do-not-leak');
});

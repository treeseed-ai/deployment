import { describe, expect, it } from 'vitest';
import { planPostgresAllocations, type PostgresInventory } from '../src/postgres/plan.js';

const topology = {
  schemaVersion: 'treeseed.postgres-topology/v1', installationId: 'test', environment: 'staging',
  servers: [{ id: 'shared', installationId: 'test', environment: 'staging', mode: 'shared', hostname: 'postgres', port: 5432, major: 17, extensions: [], tls: { mode: 'verify-full', trustReference: 'postgres-ca' } }],
  requirements: [{ id: 'api', componentId: 'api', enabled: true, supportedMajors: [17], extensions: [], runtimeConnectionLimit: 10 }],
  allocations: [{ requirementId: 'api', serverId: 'shared', database: 'api', ownerRole: 'api_owner', migrationRole: 'api_migrator', runtimeRole: 'api_runtime', migrationCredentialReference: 'api-migration', runtimeCredentialReference: 'api-runtime', onDisable: 'preserve' }],
};
const empty: PostgresInventory = { serverId: 'shared', major: 17, extensions: [], databases: [], roles: [] };
const complete: PostgresInventory = { ...empty, databases: [{ name: 'api', owner: 'api_owner', allocationId: 'test:staging:api' }],
  roles: ['api_owner', 'api_migrator', 'api_runtime'].map(name => ({ name, superuser: false, createDatabase: false, createRole: false, replication: false, bypassRls: false, allocationId: 'test:staging:api' })) };
describe('allocation preflight', () => {
  it('plans create only against observed empty custody', () => expect(planPostgresAllocations(topology, [empty]).actions[0]?.action).toBe('create'));
  it('binds plans to topology, including connection limits', () => {
    const changed = { ...topology, requirements: [{ ...topology.requirements[0]!, runtimeConnectionLimit: 11 }] };
    expect(planPostgresAllocations(changed, [empty]).topologyDigest).not.toBe(planPostgresAllocations(topology, [empty]).topologyDigest);
  });
  it('retains disabled allocations without contacting or deleting their data', () => {
    const disabled = { ...topology, requirements: [{ ...topology.requirements[0]!, enabled: false }] };
    expect(planPostgresAllocations(disabled, []).actions[0]?.action).toBe('retain');
  });
  it('requires grant and credential verification even with matching custody', () => expect(planPostgresAllocations(topology, [complete]).actions[0]?.action).toBe('verify'));
  it.each(['unmarked', 'privileged', 'partial', 'version', 'missing'])('blocks %s inventory', mode => {
    const inventory = structuredClone(complete);
    if (mode === 'unmarked') inventory.databases[0]!.allocationId = null;
    if (mode === 'privileged') inventory.roles[0]!.superuser = true;
    if (mode === 'partial') inventory.roles.pop();
    if (mode === 'version') inventory.major = 16;
    expect(planPostgresAllocations(topology, mode === 'missing' ? [] : [inventory]).ready).toBe(false);
  });
});

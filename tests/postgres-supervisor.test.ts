import { expect, it } from 'vitest';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { localPostgresTopology } from '../src/supervisor/postgres.js';
import { supervisorOperationSchema } from '../src/supervisor/protocol.js';
import { host, component } from './fixtures.js';

function fixture() {
  const configuration = host();
  configuration.components = { postgres: { ...configuration.components.api } };
  configuration.postgres = { schemaVersion: 'treeseed.postgres-topology/v1', installationId: 'test', environment: 'staging',
    servers: [{ id: 'shared', installationId: 'test', environment: 'staging', mode: 'shared', hostname: 'postgres', port: 5432, major: 17, extensions: [], tls: { mode: 'verify-full', trustReference: 'ca' } }],
    requirements: [], allocations: [] };
  const release = component('postgres', 'stable', 'a');
  release.runtimeDigest = deploymentDigest(release.runtime);
  return { configuration, releases: [release] };
}
it('keeps database environment independent of source mode', () => {
  const { configuration, releases } = fixture();
  expect(configuration.runtime.environment).toBe('production');
  expect(localPostgresTopology(configuration, releases).environment).toBe('staging');
});
it.each(['hostname', 'mode', 'port'])('does not route a different %s to the local privileged socket', field => {
  const { configuration, releases } = fixture();
  Object.assign(configuration.postgres!.servers[0]!, { [field]: { hostname: 'external.example', mode: 'external', port: 5433 }[field] });
  expect(() => localPostgresTopology(configuration, releases)).toThrow('managed local');
});
it('rejects missing or tampered installed release inventory', () => {
  const { configuration, releases } = fixture();
  expect(() => localPostgresTopology(configuration, [])).toThrow('incomplete');
  releases[0]!.runtimeDigest = `sha256:${'b'.repeat(64)}`;
  expect(() => localPostgresTopology(configuration, releases)).toThrow('digest');
});
it('rejects absent topology rather than inferring a database environment', () => {
  const { configuration, releases } = fixture(); delete configuration.postgres;
  expect(() => localPostgresTopology(configuration, releases)).toThrow('local PostgreSQL');
});
it('accepts only bounded release selections and exact plan digests', () => {
  const request = { operation: 'postgres.apply', selections: [{ componentId: 'postgres', release: '1.0.0' }], topologyDigest: 'a'.repeat(64), inventoryDigest: 'b'.repeat(64) };
  expect(supervisorOperationSchema.safeParse(request).success).toBe(true);
  for (const extra of [{ sql: 'DROP DATABASE example' }, { password: 'secret' }, { hostname: 'external.example' }]) expect(supervisorOperationSchema.safeParse({ ...request, ...extra }).success).toBe(false);
  expect(supervisorOperationSchema.safeParse({ ...request, inventoryDigest: 'latest' }).success).toBe(false);
});

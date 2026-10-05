import { expect, it } from 'vitest';
import { inspectPostgresTransferDestination } from '../src/postgres/transfer-destination.js';

const topology = {
  schemaVersion: 'treeseed.postgres-topology/v1', installationId: 'test', environment: 'staging',
  servers: [{ id: 'shared', installationId: 'test', environment: 'staging', mode: 'shared', hostname: 'postgres', port: 5432, major: 17, extensions: [], tls: { mode: 'verify-full', trustReference: 'ca' } }],
  requirements: [{ id: 'api', componentId: 'api', enabled: true, supportedMajors: [17], extensions: [], runtimeConnectionLimit: 10 }],
  allocations: [{ requirementId: 'api', serverId: 'shared', database: 'api', ownerRole: 'api_owner', migrationRole: 'api_migrator', runtimeRole: 'api_runtime', migrationCredentialReference: 'migration', runtimeCredentialReference: 'runtime', onDisable: 'preserve' }],
};
function fixture() {
  const row: Record<string, unknown> = { database: 'api', major: 17, cluster: '123', owned: true, roles: true, memberships: true, idle: true, empty: true,
    locale: { encoding: 'UTF8', collate: 'en_US.utf8', ctype: 'en_US.utf8', provider: 'c', version: '2.36', locale: null } };
  const queries: string[] = [];
  const session = { query: async (sql: string) => { queries.push(sql); return { rows: sql.includes('AS unsupported') ? [{ unsupported: false }] : [row] }; } };
  return { row, session, queries, run: () => inspectPostgresTransferDestination(topology, 'api', session) };
}
it('returns only owned destination identity and empty state, not raw cluster/verifiers', async () => {
  const f = fixture(), result = await f.run();
  expect(result.empty).toBe(true); expect(result.clusterIdentity).toMatch(/^sha256:/u);
  expect(JSON.stringify(result)).not.toContain('"123"'); expect(f.queries.at(-1)).toBe('COMMIT');
  expect(f.queries.some(sql => /rolpassword/u.test(sql))).toBe(false);
});
it.each(['owned','roles','memberships','idle'])('rejects failed %s custody without writes', async field => {
  const f = fixture(); f.row[field] = false;
  await expect(f.run()).rejects.toThrow('unchanged'); expect(f.queries.at(-1)).toBe('ROLLBACK');
});
it.each([{ database: 'foreign' }, { major: 16 }, { cluster: 'not-a-cluster' }])('rejects wrong endpoint %j', async change => {
  const f = fixture(); Object.assign(f.row, change); await expect(f.run()).rejects.toThrow('unchanged');
});
it('occupied database reports nonempty without changing its identity or adopting content', async () => {
  const f = fixture(), before = await f.run(); f.row.empty = false;
  const after = await f.run(); expect(after.empty).toBe(false); expect(after.inventoryDigest).toBe(before.inventoryDigest);
});

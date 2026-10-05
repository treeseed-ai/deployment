import { expect, it } from 'vitest';
import { postgresRuntimeAccessSql } from '../src/postgres/access.js';
import { verifyPostgresRuntimeAccess } from '../src/postgres/verify.js';
const allocation = { requirementId: 'api', serverId: 'shared', database: 'api', ownerRole: 'api_owner', migrationRole: 'api_migrator', runtimeRole: 'api_runtime', migrationCredentialReference: 'migration', runtimeCredentialReference: 'runtime', onDisable: 'preserve' };
it('grants DML, not schema ownership, to runtime', () => {
  const sql = postgresRuntimeAccessSql(allocation);
  expect(sql).toContain('ALTER SCHEMA public OWNER TO "api_owner"');
  expect(sql).toContain('REVOKE "api_owner" FROM "api_runtime"');
  expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE');
  expect(sql).not.toContain('PASSWORD');
});
it('rejects identifier injection and shared role identity', () => {
  expect(() => postgresRuntimeAccessSql({ ...allocation, database: "api'; SELECT 1" })).toThrow();
  expect(() => postgresRuntimeAccessSql({ ...allocation, runtimeRole: allocation.ownerRole })).toThrow();
});
it('never accepts missing read-back evidence', async () => {
  const result = await verifyPostgresRuntimeAccess(allocation, { query: async () => ({ rows: [] }) });
  expect(result.verified).toBe(false);
  expect(result.blockers).toContain('restrictedRuntime');
});
it('accepts only explicit true evidence for each access boundary', async () => {
  const evidence = { correctDatabase: true, isolatedOwner: true, restrictedRuntime: true, canConnect: true, cannotCreateSchemas: true, canUseSchema: true, cannotCreateTables: true, doesNotOwnObjects: true };
  expect((await verifyPostgresRuntimeAccess(allocation, { query: async () => ({ rows: [evidence] }) })).verified).toBe(true);
  expect((await verifyPostgresRuntimeAccess(allocation, { query: async () => ({ rows: [{ ...evidence, restrictedRuntime: false }] }) })).blockers).toEqual(['restrictedRuntime']);
});

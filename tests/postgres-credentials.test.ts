import { expect, it, vi } from 'vitest';
import { ensurePostgresAllocationCredentials } from '../src/postgres/credentials.js';

const topology = {
  schemaVersion: 'treeseed.postgres-topology/v1', installationId: 'test', environment: 'staging',
  servers: [{ id: 'shared', installationId: 'test', environment: 'staging', mode: 'shared', hostname: 'postgres', port: 5432, major: 17, extensions: [], tls: { mode: 'verify-full', trustReference: 'ca' } }],
  requirements: [{ id: 'api', componentId: 'api', enabled: true, supportedMajors: [17], extensions: [], runtimeConnectionLimit: 10 }],
  allocations: [{ requirementId: 'api', serverId: 'shared', database: 'api', ownerRole: 'api_owner', migrationRole: 'api_migrator', runtimeRole: 'api_runtime', migrationCredentialReference: 'migration', runtimeCredentialReference: 'runtime', onDisable: 'preserve' }],
};
const roles = () => ['api_migrator', 'api_runtime'].map(name => ({ name, initialized: false, owned: true, bounded: true }));
function harness(rows = roles()) {
  const records = new Map<string, string>();
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows }));
  const ensure = vi.fn((reference: string, generate: () => string) => {
    if (!records.has(reference)) records.set(reference, generate());
    return records.get(reference)!;
  });
  return { records, query, ensure, session: { query }, custody: { exists: (reference: string) => records.has(reference), ensure } };
}
it('generates independent credentials and retains both on replay without disclosing them', async () => {
  const h = harness();
  const result = await ensurePostgresAllocationCredentials(topology, 'api', h.session, h.custody);
  const before = [...h.records];
  expect(before).toHaveLength(2);
  expect(new Set(before.map(([, value]) => value)).size).toBe(2);
  await ensurePostgresAllocationCredentials(topology, 'api', h.session, h.custody);
  expect([...h.records]).toEqual(before);
  for (const [, value] of before) expect(JSON.stringify(result)).not.toContain(value);
  expect(h.query.mock.calls.some(([sql]) => sql.includes('PASSWORD'))).toBe(false);
});
it('rejects missing custody for either initialized role before any generation', async () => {
  const rows = roles(); rows[1]!.initialized = true;
  const h = harness(rows);
  await expect(ensurePostgresAllocationCredentials(topology, 'api', h.session, h.custody)).rejects.toThrow('restore custody');
  expect(h.ensure).not.toHaveBeenCalled();
  expect(h.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
});
it.each(['owned', 'bounded'])('rejects %s role conflict', async field => {
  const h = harness(roles().map(role => ({ ...role, [field]: false })));
  await expect(ensurePostgresAllocationCredentials(topology, 'api', h.session, h.custody)).rejects.toThrow('custody');
  expect(h.ensure).not.toHaveBeenCalled();
});
it('resumes interrupted credential generation without replacing the first record', async () => {
  const h = harness(); h.ensure.mockImplementationOnce((reference, generate) => {
    const value = generate(); h.records.set(reference, value); return value;
  }).mockImplementationOnce(() => { throw new Error('sensitive backend output'); });
  await expect(ensurePostgresAllocationCredentials(topology, 'api', h.session, h.custody)).rejects.not.toThrow('sensitive');
  const retained = h.records.get('migration');
  await ensurePostgresAllocationCredentials(topology, 'api', h.session, h.custody);
  expect(h.records.get('migration')).toBe(retained);
  expect(h.records.size).toBe(2);
});

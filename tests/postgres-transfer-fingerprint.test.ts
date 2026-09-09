import { expect, it } from 'vitest';
import { fingerprintPostgresTransfer } from '../src/postgres/transfer-fingerprint.js';
import { transferOwnershipSql, transferRelationsSql, transferSchemaSql, transferUnsupportedSql } from '../src/postgres/transfer-catalog.js';
import type { PostgresInspectionSession } from '../src/postgres/inventory.js';

function fixture() {
  const calls: string[] = [];
  const state = { owner: 'source_owner', value: '{"id":1}', unsupported: false, database: 'application', major: 16, owned: true, constraint: 'PRIMARY KEY (id)' };
  const session: PostgresInspectionSession = { query: async sql => {
    calls.push(sql);
    if (sql.includes('current_database()')) return { rows: [{ database: state.database, major: state.major, locale: { encoding: 'UTF8', collate: 'C' } }] };
    if (sql === transferUnsupportedSql) return { rows: [{ unsupported: state.unsupported }] };
    if (sql === transferOwnershipSql) return { rows: [{ owned: state.owned }] };
    if (sql === transferRelationsSql) return { rows: [{ schema: 'public', name: 'records', kind: 'r', owner: state.owner }] };
    if (sql === transferSchemaSql) return { rows: [{ kind: 'constraint', value: state.constraint }] };
    if (sql.startsWith('FETCH')) return { rows: [{ value: state.value }] };
    return { rows: [] };
  } };
  const run = () => fingerprintPostgresTransfer(session, { database: 'application', owner: 'source_owner', major: 16 });
  return { session, calls, state, run };
}
it('returns only digests/count and normalizes explicitly expected owner across majors', async () => {
  const f = fixture(), first = await f.run();
  f.state.major = 17; f.state.owner = 'target_owner';
  const second = await fingerprintPostgresTransfer(f.session, { database: 'application', owner: 'target_owner', major: 17 });
  expect(first).toEqual(second); expect(JSON.stringify(first)).not.toContain('records');
  expect(f.calls.at(-1)).toBe('COMMIT');
});
it.each(['value','constraint'] as const)('detects changed %s', async field => {
  const f = fixture(), first = await f.run(); f.state[field] += ' changed';
  expect(await f.run()).not.toEqual(first);
});
it.each(['owner','unsupported','database','major','owned'] as const)('rejects unexpected %s and rolls back', async field => {
  const f = fixture();
  if (field === 'owner') f.state.owner = 'other';
  if (field === 'database') f.state.database = 'other';
  if (field === 'major') f.state.major = 17;
  if (field === 'unsupported') f.state.unsupported = true;
  if (field === 'owned') f.state.owned = false;
  await expect(f.run()).rejects.toThrow('binding unchanged'); expect(f.calls.at(-1)).toBe('ROLLBACK');
});
it('redacts database errors and attempts rollback', async () => {
  const f = fixture(), query = f.session.query;
  f.session.query = async (sql, values) => { if (sql.startsWith('FETCH')) throw new Error('secret database content'); return query(sql, values); };
  await expect(f.run()).rejects.toThrow('fingerprint unavailable'); expect(f.calls.at(-1)).toBe('ROLLBACK');
});

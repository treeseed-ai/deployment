import { describe, expect, it } from 'vitest';
import { inspectPostgresAllocations, postgresAllocationMarker } from '../src/postgres/inventory.js';

function session(marker: unknown = postgresAllocationMarker('test:staging:api')) {
  const statements: string[] = [];
  return { statements, async query(sql: string) {
    statements.push(sql);
    if (sql.includes('server_version_num')) return { rows: [{ version: 170006 }] };
    if (sql.includes('pg_available_extensions')) return { rows: [{ name: 'pgcrypto' }] };
    if (sql.includes('FROM pg_database')) return { rows: [{ name: 'api', owner: 'api_owner', marker, allowConnections: true }] };
    if (sql.includes('FROM pg_roles')) return { rows: [{ name: 'api_owner', marker, superuser: false, createDatabase: false, createRole: false, replication: false, bypassRls: false, login: false, memberships: false }] };
    return { rows: [] };
  } };
}
describe('PostgreSQL read-only inspection', () => {
  it('reads a consistent inventory without selecting credentials', async () => {
    const connection = session();
    const inventory = await inspectPostgresAllocations('shared', connection);
    expect(inventory.major).toBe(17);
    expect(inventory.extensions).toEqual(['pgcrypto']);
    expect(inventory.databases[0]?.allocationId).toBe('test:staging:api');
    expect(connection.statements[0]).toContain('REPEATABLE READ READ ONLY');
    expect(connection.statements.at(-1)).toBe('COMMIT');
    expect(connection.statements.join('\n')).not.toMatch(/rolpassword|SELECT \*/i);
  });
  it.each([null, 'unmanaged', '{}', '{"schemaVersion":"other","allocationId":"test"}'])('does not adopt an unrecognized marker %s', async marker => {
    expect((await inspectPostgresAllocations('shared', session(marker))).databases[0]?.allocationId).toBeNull();
  });
  it('rolls back and redacts driver failures', async () => {
    const connection = session();
    const original = connection.query.bind(connection);
    connection.query = async sql => {
      if (sql.includes('pg_database')) throw new Error('sensitive driver context');
      return original(sql);
    };
    await expect(inspectPostgresAllocations('shared', connection)).rejects.toThrow('PostgreSQL allocation inspection failed');
    expect(connection.statements.at(-1)).toBe('ROLLBACK');
  });
});

import { expect, it } from 'vitest';
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { activatePostgresAllocation, postgresPasswordVerifier } from '../src/postgres/activation.js';

it('generates salted SCRAM verifiers without returning the password', () => {
  const password = 'a'.repeat(64);
  const verifier = postgresPasswordVerifier(password);
  const match = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/u.exec(verifier)!;
  expect(match).not.toBeNull();
  const salted = pbkdf2Sync(password, Buffer.from(match[2]!, 'base64'), Number(match[1]), 32, 'sha256');
  expect(match[3]).toBe(createHash('sha256').update(createHmac('sha256', salted).update('Client Key').digest()).digest('base64'));
  expect(match[4]).toBe(createHmac('sha256', salted).update('Server Key').digest('base64'));
  expect(verifier).not.toContain(password);
  expect(postgresPasswordVerifier(password)).not.toBe(verifier);
});
it.each(['short', "a'.repeat(64)", 'ä'.repeat(64), ' '.repeat(64)])('rejects non-generated password syntax', password => {
  expect(() => postgresPasswordVerifier(password)).toThrow('generated PostgreSQL credential');
});
const topology = {
  schemaVersion: 'treeseed.postgres-topology/v1', installationId: 'test', environment: 'staging',
  servers: [{ id: 'shared', installationId: 'test', environment: 'staging', mode: 'shared', hostname: 'postgres', port: 5432, major: 17, extensions: [], tls: { mode: 'verify-full', trustReference: 'ca' } }],
  requirements: [{ id: 'api', componentId: 'api', enabled: true, supportedMajors: [17], extensions: [], runtimeConnectionLimit: 10 }],
  allocations: [{ requirementId: 'api', serverId: 'shared', database: 'api', ownerRole: 'api_owner', migrationRole: 'api_migrator', runtimeRole: 'api_runtime', migrationCredentialReference: 'migration', runtimeCredentialReference: 'runtime', onDisable: 'preserve' }],
};
it.each(['owned', 'roles', 'idle', 'memberships'])('rejects failed %s evidence before credential SQL', async key => {
  const queries: string[] = [];
  const session = { query: async (sql: string) => {
    queries.push(sql); return { rows: [{ owned: true, roles: true, idle: true, memberships: true, [key]: false }] };
  } };
  await expect(activatePostgresAllocation(topology, 'api', 'runtime', 'a'.repeat(64), session)).rejects.toThrow('activation failed');
  expect(queries.at(-1)).toBe('ROLLBACK');
  expect(queries.some(sql => sql.includes('PASSWORD'))).toBe(false);
});

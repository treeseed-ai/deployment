import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { postgresClientMaterial } from '../src/postgres/client-files.js';

const topology = {
  schemaVersion: 'treeseed.postgres-topology/v1', installationId: 'test', environment: 'staging',
  servers: [{ id: 'shared', installationId: 'test', environment: 'staging', mode: 'shared', hostname: 'postgres', port: 5432, major: 17, extensions: [], tls: { mode: 'verify-full', trustReference: 'ca' } }],
  requirements: [{ id: 'api', componentId: 'api', enabled: true, supportedMajors: [17], extensions: [], runtimeConnectionLimit: 10 }],
  allocations: [{ requirementId: 'api', serverId: 'shared', database: 'api', ownerRole: 'api_owner', migrationRole: 'api_migrator', runtimeRole: 'api_runtime', migrationCredentialReference: 'migration', runtimeCredentialReference: 'runtime', onDisable: 'preserve' }],
};
it('renders phase-specific file inputs with mandatory TLS and without bootstrap authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'treeseed-postgres-client-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=postgres', '-days', '1', '-keyout', join(root, 'key'), '-out', join(root, 'cert')], { stdio: 'ignore' });
    const certificate = readFileSync(join(root, 'cert'), 'utf8');
    for (const phase of ['migration', 'runtime'] as const) {
      const result = postgresClientMaterial(topology, 'api', phase, 'a'.repeat(64), certificate);
      expect(result.files.username).toBe(phase === 'migration' ? 'api_migrator' : 'api_runtime');
      const url = new URL(result.files.url);
      expect(url.searchParams.get('sslmode')).toBe('verify-full');
      expect(url.searchParams.get('sslrootcert')).toBe(`${result.mount}/ca.pem`);
      expect(result.files['jdbc-url']).not.toContain('a'.repeat(64));
      expect(JSON.stringify(result)).not.toContain('api_owner');
    }
    expect(() => postgresClientMaterial(topology, 'unknown', 'runtime', 'a'.repeat(64), certificate)).toThrow();
    expect(() => postgresClientMaterial(topology, 'api', 'runtime', 'a'.repeat(64), 'invalid')).toThrow('TLS trust');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { afterAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { identityBootstrapRealm, prepareIdentityBootstrap } from '../src/identity/bootstrap.js';

// Container UID ownership requires root; exercise real custody/filesystem recovery without it.
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), chownSync: vi.fn() }));

const root = mkdtempSync(join(tmpdir(), 'treeseed-identity-bootstrap-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=test', '-keyout', join(root, 'key'), '-out', join(root, 'cert')], { stdio: 'ignore' });
const certificate = readFileSync(join(root, 'cert'), 'utf8');
describe('Identity realm bootstrap boundary', () => {
  it('restores Identity reboot placeholders from unchanged protected custody', () => {
    const input = { publicUrl: 'https://identity.example.test', stateRoot: join(root, 'state'), runtimeRoot: join(root, 'runtime'),
      environment: 'staging' as const, certificateAuthority: join(root, 'cert'), certificateAuthorityKey: join(root, 'key'),
      credentialCommand: (args: string[]) => args[0] === 'encrypt' ? Buffer.from('synthetic-sealed-key') : Buffer.alloc(32, 7) };
    prepareIdentityBootstrap(input);
    const key = readFileSync(join(input.runtimeRoot, 'tls/key.pem'));
    const cert = readFileSync(join(input.runtimeRoot, 'tls/cert.pem'));
    rmSync(input.runtimeRoot, { recursive: true });
    for (const path of ['tls/key.pem','tls/cert.pem','import/treeseed-realm.json']) mkdirSync(join(input.runtimeRoot, path), { recursive: true, mode: 0o755 });
    chmodSync(input.runtimeRoot, 0o755);
    prepareIdentityBootstrap(input);
    expect(statSync(input.runtimeRoot).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(input.runtimeRoot, 'tls/key.pem')).equals(key)).toBe(true);
    expect(readFileSync(join(input.runtimeRoot, 'tls/cert.pem')).equals(cert)).toBe(true);
    prepareIdentityBootstrap(input);
    expect(readFileSync(join(input.runtimeRoot, 'tls/key.pem')).equals(key)).toBe(true);
  });
  it('creates only an asymmetric realm reconciler, not a password account or application roles', () => {
    const realm = identityBootstrapRealm(certificate, 'https://identity.example.test');
    expect(realm.registrationAllowed).toBe(false);
    expect(realm.clients[0]).toMatchObject({ clientAuthenticatorType: 'client-jwt', standardFlowEnabled: false, directAccessGrantsEnabled: false, fullScopeAllowed: false });
    expect(realm.users).toHaveLength(1);
    expect(realm.users[0]).toMatchObject({ serviceAccountClientId: 'treeseed-identity-reconciler' });
    expect(realm.users[0]).not.toHaveProperty('credentials');
    expect(realm).not.toHaveProperty('roles');
    expect(JSON.stringify(realm)).not.toContain('PRIVATE KEY');
    expect(realm.clients[0]?.protocolMappers[0]?.config['included.custom.audience']).toBe('https://identity.example.test/admin/realms/treeseed');
  });
  it.each(['http://identity.test', 'https://identity.test/other', 'https://user:pass@identity.test'])('rejects unsafe origin %s before custody writes', publicUrl => {
    expect(() => identityBootstrapRealm(certificate, publicUrl)).toThrow();
    expect(() => prepareIdentityBootstrap({ publicUrl, stateRoot: root, runtimeRoot: root, environment: 'staging', certificateAuthority: '', certificateAuthorityKey: '' })).toThrow();
  });
});

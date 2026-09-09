import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { identityBootstrapRealm, prepareIdentityBootstrap } from '../src/identity/bootstrap.js';

const root = mkdtempSync(join(tmpdir(), 'treeseed-identity-bootstrap-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=test', '-keyout', join(root, 'key'), '-out', join(root, 'cert')], { stdio: 'ignore' });
const certificate = readFileSync(join(root, 'cert'), 'utf8');
describe('Identity realm bootstrap boundary', () => {
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

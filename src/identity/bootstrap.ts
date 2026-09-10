import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, chownSync, chmodSync } from 'node:fs';
import { randomUUID, X509Certificate } from 'node:crypto';
import { join } from 'node:path';
import { OsSecretCustody, type CredentialCommand } from '../security/custody/os.js';
import { LocalSecretCustody } from '../security/custody/local.js';

/** Local managed-host bootstrap only. Railway supplies independent protected
 * bootstrap material through its adapter. No API/OpenBao startup dependency.
 */
export function prepareIdentityBootstrap(options: {
  stateRoot: string; runtimeRoot: string; publicUrl: string; environment: 'staging' | 'production';
  certificateAuthority: string; certificateAuthorityKey: string; credentialCommand?: CredentialCommand;
}) {
  const publicUrl = new URL(options.publicUrl);
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(publicUrl.hostname) || !['staging', 'production'].includes(options.environment)) throw new Error('Invalid Identity bootstrap boundary');
  for (const root of [options.stateRoot, options.runtimeRoot]) {
    mkdirSync(root, { recursive: true, mode: 0o700 }); new LocalSecretCustody(root);
  }
  const store = new OsSecretCustody(join(options.stateRoot, 'identity-os'), false, options.credentialCommand);
  const scope = { team: 'host', project: 'identity', environment: options.environment, purpose: 'bootstrap', name: 'reconciler' };
  const authority = readFileSync(options.certificateAuthority, 'utf8');
  let identity = store.initialized ? store.run(custody => custody.read(scope))?.values : undefined;
  if (!identity) {
    if (store.initialized) throw new Error('Existing Identity custody must be restored for this environment');
    const temporary = mkdtempSync(join(options.runtimeRoot, 'bootstrap-'));
    const run = (args: string[]) => execFileSync('/usr/bin/openssl', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    try {
      run(['req', '-new', '-newkey', 'rsa:3072', '-nodes', '-subj', '/CN=treeseed-identity', '-keyout', join(temporary, 'server.key'), '-out', join(temporary, 'server.csr')]);
      writeFileSync(join(temporary, 'server.ext'), `subjectAltName=DNS:identity,DNS:${publicUrl.hostname}\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 });
      run(['x509', '-req', '-in', join(temporary, 'server.csr'), '-CA', options.certificateAuthority, '-CAkey', options.certificateAuthorityKey,
        '-set_serial', `0x${randomUUID().replaceAll('-', '')}`, '-days', '365', '-sha256', '-extfile', join(temporary, 'server.ext'), '-out', join(temporary, 'server.crt')]);
      run(['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '365', '-subj', '/CN=treeseed-identity-reconciler',
        '-keyout', join(temporary, 'reconciler.key'), '-out', join(temporary, 'reconciler.crt')]);
      identity = { publicUrl: publicUrl.origin, authority, serverKey: readFileSync(join(temporary, 'server.key'), 'utf8'), serverCertificate: readFileSync(join(temporary, 'server.crt'), 'utf8'),
        reconcilerKey: readFileSync(join(temporary, 'reconciler.key'), 'utf8'), reconcilerCertificate: readFileSync(join(temporary, 'reconciler.crt'), 'utf8') };
      store.run(custody => custody.write(scope, identity!, 0), true);
    } catch { throw new Error('Identity bootstrap creation failed'); }
    finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  if (identity.publicUrl !== publicUrl.origin || identity.authority !== authority || !identity.serverKey || !identity.reconcilerKey || !identity.reconcilerCertificate || !identity.serverCertificate)
    throw new Error('Identity bootstrap binding changed; coordinated rotation or recovery is required');
  const certificate = new X509Certificate(identity.serverCertificate);
  if (Date.parse(certificate.validTo) <= Date.now() || !certificate.checkHost(publicUrl.hostname) || !certificate.verify(new X509Certificate(authority).publicKey)) throw new Error('Identity TLS renewal or recovery required');
  const realm = identityBootstrapRealm(identity.reconcilerCertificate, publicUrl.origin);
  const tls = join(options.runtimeRoot, 'tls'), imported = join(options.runtimeRoot, 'import');
  for (const path of [tls, imported]) {
    mkdirSync(path, { recursive: true, mode: 0o755 });
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw new Error('Unsafe Identity runtime directory');
    chmodSync(path, 0o755); // Explicit container traversal, independent of supervisor umask; files remain UID1000/0400.
  }
  const materialize = (path: string, content: string) => {
    const temporary = `${path}.tmp-${randomUUID()}`;
    try { writeFileSync(temporary, content, { flag: 'wx', mode: 0o400 }); chownSync(temporary, 1000, 0); renameSync(temporary, path); }
    finally { if (existsSync(temporary)) rmSync(temporary); }
  };
  materialize(join(tls, 'cert.pem'), `${identity.serverCertificate}\n${authority}`);
  materialize(join(tls, 'key.pem'), identity.serverKey);
  materialize(join(imported, 'treeseed-realm.json'), JSON.stringify(realm));
  return { configured: true, publicUrl: publicUrl.origin, realm: 'treeseed', custody: 'os' as const };
}

/** Bootstrap grants only realm configuration authority to an asymmetric
 * Deployment reconciler. It creates no human, team or application permissions.
 */
export function identityBootstrapRealm(reconcilerCertificate: string, publicUrl: string) {
  const origin = new URL(publicUrl);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid Identity realm origin');
  const certificate = new X509Certificate(reconcilerCertificate).raw.toString('base64');
  const clientId = 'treeseed-identity-reconciler';
  return { realm: 'treeseed', enabled: true, sslRequired: 'all', registrationAllowed: false, accessTokenLifespan: 300,
    clients: [{ clientId, enabled: true, protocol: 'openid-connect', publicClient: false, clientAuthenticatorType: 'client-jwt',
      attributes: { 'jwt.credential.certificate': certificate, 'token.endpoint.auth.signing.alg': 'RS256' },
      serviceAccountsEnabled: true, standardFlowEnabled: false, directAccessGrantsEnabled: false, fullScopeAllowed: false,
      defaultClientScopes: ['roles'], optionalClientScopes: [],
      protocolMappers: [{ name: 'reconciler-audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper',
        config: { 'included.custom.audience': `${origin.origin}/admin/realms/treeseed`, 'access.token.claim': 'true', 'id.token.claim': 'false' } }] }],
    clientScopeMappings: { 'realm-management': [{ client: clientId, roles: ['realm-admin'] }] },
    users: [{ username: `service-account-${clientId}`, enabled: true, serviceAccountClientId: clientId,
      clientRoles: { 'realm-management': ['realm-admin'] } }] };
}

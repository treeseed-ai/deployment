// Disposable compatibility test only. Not a production bootstrap or identity issuer.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { setTimeout as pause } from 'node:timers/promises';
import { createAccessTokenVerifier } from '@treeseed/identity';
import { createLocalJWKSet } from 'jose';

const images = {
  keycloak: 'quay.io/keycloak/keycloak:26.7.3@sha256:ff4257d0d64efbe99ed1ddfaf07765cc3c36dc7518bf8324d41961327f441c54',
  postgres: 'postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94',
};
const root = mkdtempSync(join(tmpdir(), 'treeseed-identity-acceptance-'));
const prefix = `treeseed-identity-test-${randomBytes(6).toString('hex')}`;
const names = [];
const originalTrust = getCACertificates('default');
let networkCreated = false;
let stage = 'preflight';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 }).trim();
const checks = [];
async function port() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
async function ready(url) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (response.ok) return response.json(); } catch {}
    await pause(1000);
  }
  throw new Error('Readiness timeout');
}
async function start(label) {
  stage = `start-${label}`;
  const directory = join(root, label); mkdirSync(directory, { mode: 0o755 });
  const password = randomBytes(32).toString('hex');
  const secret = randomBytes(32).toString('hex');
  const db = `${prefix}-${label}-db`, server = `${prefix}-${label}`;
  const listenPort = await port();
  const base = `https://127.0.0.1:${listenPort}`;
  const issuer = `${base}/realms/acceptance`;
  writeFileSync(join(directory, 'realm.json'), JSON.stringify({
    realm: 'acceptance', enabled: true, sslRequired: 'all', accessTokenLifespan: 60,
    clients: [{ clientId: 'workload-test', enabled: true, protocol: 'openid-connect', publicClient: false,
      secret, serviceAccountsEnabled: true, standardFlowEnabled: false, directAccessGrantsEnabled: false,
      protocolMappers: [{ name: 'audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper',
        config: { 'included.custom.audience': 'https://api.example.test', 'access.token.claim': 'true' } }] }],
  }), { mode: 0o644 });
  // Synthetic, one-run credentials only; never print Docker output or imported records.
  writeFileSync(join(directory, 'db.env'), `POSTGRES_DB=identity\nPOSTGRES_USER=identity\nPOSTGRES_PASSWORD=${password}\n`, { mode: 0o600 });
  writeFileSync(join(directory, 'kc.env'), `KC_DB=postgres\nKC_DB_URL=jdbc:postgresql://${db}:5432/identity\nKC_DB_USERNAME=identity\nKC_DB_PASSWORD=${password}\n`, { mode: 0o600 });
  names.push(db);
  docker('run', '-d', '--name', db, '--network', prefix, '--tmpfs', '/var/lib/postgresql/data', '--env-file', join(directory, 'db.env'), images.postgres);
  names.push(server);
  docker('run', '-d', '--name', server, '--network', prefix, '-p', `127.0.0.1:${listenPort}:8443`,
    '--env-file', join(directory, 'kc.env'),
    '-v', `${join(root, 'tls')}:/run/identity-test:ro`,
    '-v', `${join(directory, 'realm.json')}:/opt/keycloak/data/import/acceptance-realm.json:ro`,
    images.keycloak, 'start', '--import-realm', `--hostname=${base}`, '--http-enabled=false',
    '--https-certificate-file=/run/identity-test/cert.pem', '--https-certificate-key-file=/run/identity-test/key.pem');
  const discovery = await ready(`${issuer}/.well-known/openid-configuration`);
  assert.equal(discovery.issuer, issuer);
  assert.equal(discovery.token_endpoint, `${issuer}/protocol/openid-connect/token`);
  assert.equal(discovery.jwks_uri, `${issuer}/protocol/openid-connect/certs`);
  const token = async () => {
    const response = await fetch(discovery.token_endpoint, { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'workload-test', client_secret: secret }), signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200);
    return (await response.json()).access_token;
  };
  const keys = createLocalJWKSet(await (await fetch(discovery.jwks_uri)).json());
  const verifier = (audience = 'https://api.example.test') => createAccessTokenVerifier({ issuer, audience, profile: 'keycloak', verificationKey: keys,
    resolvePrincipal: async identity => ({ principalId: `${label}:${identity.subject}`, kind: 'service' }) });
  return { server, issuer, token, verifier, discovery };
}
try {
  docker('info', '--format', '{{.ServerVersion}}');
  for (const image of Object.values(images)) docker('pull', image);
  docker('network', 'create', '--internal', prefix); networkCreated = true;
  mkdirSync(join(root, 'tls'), { mode: 0o755 });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=disposable-identity',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(root, 'tls/key.pem'), '-out', join(root, 'tls/cert.pem')], { stdio: 'ignore' });
  chmodSync(join(root, 'tls/key.pem'), 0o644);
  setDefaultCACertificates([...originalTrust, readFileSync(join(root, 'tls/cert.pem'), 'utf8')]);
  const first = await start('sovereign');
  const second = await start('central');
  stage = 'token-validation';
  const before = await first.verifier()(await first.token());
  assert.equal(before.kind, 'service'); checks.push('real-keycloak-token', 'verified-tls', 'separate-databases');
  await assert.rejects(first.verifier()(await second.token())); checks.push('untrusted-issuer-denied');
  await assert.rejects(first.verifier('https://wrong.example.test')(await first.token())); checks.push('wrong-audience-denied');
  stage = 'sovereign-outage';
  docker('stop', second.server);
  assert.equal((await first.verifier()(await first.token())).principalId, before.principalId);
  checks.push('local-auth-with-central-offline');
  stage = 'restart';
  docker('restart', first.server);
  await ready(`${first.issuer}/.well-known/openid-configuration`);
  assert.equal((await first.verifier()(await first.token())).principalId, before.principalId);
  checks.push('restart-preserves-subject');
  console.log(JSON.stringify({ ok: true, images, checks, deferred: ['human-sso', 'directional-brokering', 'asymmetric-workload-exchange', 'spire', 'live-migration'] }));
} catch {
  console.error(JSON.stringify({ ok: false, stage, error: 'Disposable identity acceptance failed; no credentials or raw provider output emitted.' }));
  process.exitCode = 1;
} finally {
  for (const name of names.reverse()) { try { docker('rm', '-f', '-v', name); } catch {} }
  if (networkCreated) { try { docker('network', 'rm', prefix); } catch {} }
  setDefaultCACertificates(originalTrust);
  rmSync(root, { recursive: true, force: true });
}

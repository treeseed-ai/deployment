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
import { createLocalJWKSet, importPKCS8, SignJWT } from 'jose';
import { browserFixture } from './browser.js';
import { recoverIdentityDatabase } from './recovery.js';
import { managedIdentityServices, IDENTITY_IMAGES } from '../../dist/src/identity/compose.js';
import { POSTGRES_IMAGE } from '../../dist/src/postgres/compose.js';
import { startSharedDatabase } from './database.js';

const images = { ...IDENTITY_IMAGES, postgres: POSTGRES_IMAGE };
const root = mkdtempSync(join(tmpdir(), 'treeseed-identity-acceptance-'));
const prefix = `treeseed-identity-test-${randomBytes(6).toString('hex')}`;
const names = [];
const privateNetworks: string[] = [];
const syntheticSecrets = [];
const originalTrust = getCACertificates('default');
let networkCreated = false;
let browsers: Awaited<ReturnType<typeof browserFixture>> | undefined;
let sharedDatabase: ReturnType<typeof startSharedDatabase>;
let firstDatabasePassword = '';
const humanPassword = randomBytes(32).toString('hex');
syntheticSecrets.push(humanPassword);
const brokerSecret = randomBytes(32).toString('hex');
syntheticSecrets.push(brokerSecret);
type Label = 'sovereign' | 'central';
const ports = { sovereign: 0, central: 0 };
const issuerFor = (label: Label) => `https://${label}.localhost:${ports[label]}/realms/acceptance`;
let stage = 'preflight';
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 }).trim();
const checks = [];
async function port() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const value = address.port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return value;
}
async function ready(url: string) {
  let failure = 'unknown';
  for (let attempt = 0; attempt < 120; attempt++) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (response.ok) return response.json(); failure = `http-${response.status}`; }
    catch (error) { failure = error instanceof Error ? error.name : 'unknown'; }
    await pause(1000);
  }
  console.error(JSON.stringify({ readinessFailure: failure }));
  try { console.error(JSON.stringify({ curlStatus: execFileSync('curl', ['--silent', '--show-error', '--max-time', '5', '--cacert', join(root, 'tls/cert.pem'), '-o', '/dev/null', '-w', '%{http_code}', url], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) })); } catch (error) { console.error(JSON.stringify({ curlExit: error && typeof error === 'object' && 'status' in error ? error.status : null })); }
  throw new Error('Readiness timeout');
}
async function start(label: Label) {
  assert.ok(browsers);
  stage = `start-${label}`;
  const directory = join(root, label); mkdirSync(directory, { mode: 0o755 });
  mkdirSync(join(directory, 'tls'), { mode: 0o755 });
  const password = randomBytes(32).toString('hex');
  const migrationPassword = randomBytes(32).toString('hex');
  syntheticSecrets.push(password, migrationPassword);
  if (label === 'sovereign') firstDatabasePassword = password;
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${label}-workload`,
    '-keyout', join(directory, 'client.key'), '-out', join(directory, 'client.crt')], { stdio: 'ignore' });
  const clientKey = await importPKCS8(readFileSync(join(directory, 'client.key'), 'utf8'), 'RS256');
  const certificate = readFileSync(join(directory, 'client.crt'), 'utf8').replace(/-----[^-]+-----|\s/g, '');
  const db = await sharedDatabase.allocate(label, password, migrationPassword), server = `${prefix}-${label}`;
  const listenPort = ports[label];
  const base = `https://${label}.localhost:${listenPort}`;
  const issuer = `${base}/realms/acceptance`;
  writeFileSync(join(directory, 'realm.json'), JSON.stringify({
    realm: 'acceptance', enabled: true, sslRequired: 'all', accessTokenLifespan: 60,
    users: [{ username: label === 'central' ? 'central-user' : 'acceptance-user', enabled: true, emailVerified: true, email: `${label}@example.test`, firstName: 'Acceptance', lastName: 'User',
      credentials: [{ type: 'password', value: humanPassword, temporary: false }] }],
    identityProviders: label === 'sovereign' ? [{ alias: 'central', displayName: 'Explicit central trust', providerId: 'oidc', enabled: true,
      trustEmail: false, storeToken: false, firstBrokerLoginFlowAlias: 'first broker login',
      config: { clientId: 'sovereign-broker', clientSecret: brokerSecret, clientAuthMethod: 'client_secret_post',
        issuer: issuerFor('central'), authorizationUrl: `${issuerFor('central')}/protocol/openid-connect/auth`,
        tokenUrl: `${issuerFor('central')}/protocol/openid-connect/token`, userInfoUrl: `${issuerFor('central')}/protocol/openid-connect/userinfo`,
        jwksUrl: `${issuerFor('central')}/protocol/openid-connect/certs`, useJwksUrl: 'true', validateSignature: 'true',
        defaultScope: 'openid profile email', syncMode: 'IMPORT' } }] : [],
    clients: [{ clientId: 'workload-test', enabled: true, protocol: 'openid-connect', publicClient: false,
      clientAuthenticatorType: 'client-jwt', attributes: { 'jwt.credential.certificate': certificate, 'token.endpoint.auth.signing.alg': 'RS256' },
      serviceAccountsEnabled: true, standardFlowEnabled: false, directAccessGrantsEnabled: false,
      protocolMappers: [{ name: 'audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper',
        config: { 'included.custom.audience': 'https://api.example.test', 'access.token.claim': 'true' } }] }, ...browsers.clients,
      ...(label === 'central' ? [{ clientId: 'sovereign-broker', enabled: true, protocol: 'openid-connect', publicClient: false,
        secret: brokerSecret, standardFlowEnabled: true, directAccessGrantsEnabled: false,
        redirectUris: [`${issuerFor('sovereign')}/broker/central/endpoint`] }] : [])],
  }), { mode: 0o644 });
  // Synthetic, one-run credentials only; never print Docker output or imported records.
  writeFileSync(join(directory, 'database-password'), migrationPassword, { mode: 0o444 });
  writeFileSync(join(directory, 'database-ca.pem'), readFileSync(join(root, 'tls/cert.pem')), { mode: 0o444 });
  const managed = managedIdentityServices({ publicUrl: base, configurationRoot: directory, database: { ...db, username: `${db.username}_migrator` }, databasePhase: 'migration' });
  const services = {
    identity: { ...managed.identity, container_name: server,
      networks: { private: { aliases: [`${label}.localhost`] }, broker: { aliases: [`${label}.localhost`] } }, ports: [`127.0.0.1:${listenPort}:${listenPort}`],
      volumes: [...managed.identity.volumes, { type: 'bind', source: join(root, 'tls'), target: '/run/identity/tls', read_only: true },
        { type: 'bind', source: join(directory, 'realm.json'), target: '/opt/keycloak/data/import/acceptance-realm.json', read_only: true }],
      command: [...managed.identity.command.map(value => value === '--https-port=8443' ? `--https-port=${listenPort}` : value), '--import-realm'] },
  };
  // Applications share a server, not roles or databases. The private broker
  // network carries verified TLS database connections as well as OIDC traffic.
  services.identity.networks.broker = { aliases: [`${label}.localhost`] };
  const composePath = join(directory, 'compose.json');
  writeFileSync(composePath, JSON.stringify({ services, networks: { private: {}, broker: { external: true, name: prefix } } }));
  names.push(server);
  privateNetworks.push(`${prefix}-${label}_private`);
  docker('compose', '-p', `${prefix}-${label}`, '-f', composePath, 'up', '-d');
  await ready(`${issuer}/.well-known/openid-configuration`);
  docker('stop', server);
  await sharedDatabase.activateRuntime(label);
  chmodSync(join(directory, 'database-password'), 0o600);
  writeFileSync(join(directory, 'database-password'), password, { mode: 0o444 });
  chmodSync(join(directory, 'database-password'), 0o444);
  const runtime = managedIdentityServices({ publicUrl: base, configurationRoot: directory, database: db });
  services.identity.environment = runtime.identity.environment;
  services.identity.command = runtime.identity.command.map(value => value === '--https-port=8443' ? `--https-port=${listenPort}` : value);
  writeFileSync(composePath, JSON.stringify({ services, networks: { private: {}, broker: { external: true, name: prefix } } }));
  docker('compose', '-p', `${prefix}-${label}`, '-f', composePath, 'up', '-d');
  const discovery = await ready(`${issuer}/.well-known/openid-configuration`);
  assert.equal(discovery.issuer, issuer);
  assert.equal(discovery.token_endpoint, `${issuer}/protocol/openid-connect/token`);
  assert.equal(discovery.jwks_uri, `${issuer}/protocol/openid-connect/certs`);
  const token = async (signingKey = clientKey) => {
    const assertion = await new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setIssuer('workload-test').setSubject('workload-test')
      .setAudience(issuer).setIssuedAt().setExpirationTime('60s').setJti(randomBytes(16).toString('hex')).sign(signingKey);
    syntheticSecrets.push(assertion);
    const response = await fetch(discovery.token_endpoint, { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'workload-test',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion }), signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200);
    return (await response.json()).access_token;
  };
  const keys = createLocalJWKSet(await (await fetch(discovery.jwks_uri)).json());
  const verifier = (audience = 'https://api.example.test') => createAccessTokenVerifier({ issuer, audience, profile: 'keycloak', verificationKey: keys,
    resolvePrincipal: async identity => ({ principalId: `${label}:${identity.subject}`, kind: 'service' }) });
  return { server, database: sharedDatabase.name, databaseName: db.database, issuer, token, verifier, discovery, clientKey };
}
try {
  docker('info', '--format', '{{.ServerVersion}}');
  for (const image of Object.values(images)) docker('pull', image);
  // A regular isolated bridge permits the runner's loopback-published TLS ports.
  // Docker internal networks suppress this host-port route on current runners.
  docker('network', 'create', prefix); networkCreated = true;
  ports.sovereign = await port(); ports.central = await port();
  mkdirSync(join(root, 'tls'), { mode: 0o755 });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=disposable-identity',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:postgres,DNS:admin.localhost,DNS:market.localhost,DNS:sovereign.localhost,DNS:central.localhost', '-keyout', join(root, 'tls/key.pem'), '-out', join(root, 'tls/cert.pem')], { stdio: 'ignore' });
  chmodSync(join(root, 'tls/key.pem'), 0o644);
  setDefaultCACertificates([...originalTrust, readFileSync(join(root, 'tls/cert.pem'), 'utf8')]);
  browsers = await browserFixture(root);
  const bootstrapPassword = randomBytes(32).toString('hex'); syntheticSecrets.push(bootstrapPassword);
  names.push(`${prefix}-postgres`);
  stage = 'shared-database';
  sharedDatabase = startSharedDatabase({ root, prefix, password: bootstrapPassword, docker });
  checks.push(...await sharedDatabase.verifySession());
  const first = await start('sovereign');
  const second = await start('central');
  checks.push('allocation-custody-apply', 'allocation-stale-plan-denied', 'allocation-custody-replay', 'allocation-roles-start-disabled');
  stage = 'database-isolation';
  checks.push(...await sharedDatabase.verifyIsolation(firstDatabasePassword));
  stage = 'token-validation';
  const before = await first.verifier()(await first.token());
  assert.equal(before.kind, 'service'); checks.push('real-keycloak-token', 'private-key-jwt-client-authentication', 'verified-tls', 'separate-databases');
  await assert.rejects(first.token(second.clientKey)); checks.push('unregistered-workload-key-denied');
  await assert.rejects(first.verifier()(await second.token())); checks.push('untrusted-issuer-denied');
  await assert.rejects(second.verifier()(await first.token())); checks.push('reverse-issuer-token-denied');
  await assert.rejects(first.verifier('https://wrong.example.test')(await first.token())); checks.push('wrong-audience-denied');
  stage = 'federated-browser';
  checks.push(...await browsers.verifyFederation(first.issuer, second.issuer, humanPassword));
  stage = 'sovereign-outage';
  docker('stop', second.server);
  assert.equal((await first.verifier()(await first.token())).principalId, before.principalId);
  checks.push('local-auth-with-central-offline');
  stage = 'browser-sso';
  checks.push(...await browsers.verify(first.issuer, humanPassword));
  stage = 'restart';
  docker('restart', first.server);
  await ready(`${first.issuer}/.well-known/openid-configuration`);
  assert.equal((await first.verifier()(await first.token())).principalId, before.principalId);
  checks.push('restart-preserves-subject');
  stage = 'database-recovery';
  checks.push(...recoverIdentityDatabase(first));
  await ready(`${first.issuer}/.well-known/openid-configuration`);
  assert.equal((await first.verifier()(await first.token())).principalId, before.principalId);
  checks.push('database-restore-preserves-workload-subject-and-signing-key');
  checks.push(...(await browsers.verify(first.issuer, humanPassword)).map(check => `restored-${check}`));
  console.log(JSON.stringify({ ok: true, images, checks, deferred: ['live-application-sso', 'federation-reconciliation-revocation', 'transitive-trust-negative', 'asymmetric-workload-exchange', 'spire', 'live-migration'] }));
} catch (error) {
  if (error instanceof Error && /^Managed PostgreSQL operation failed \([A-Za-z0-9_]+\)$/u.test(error.message)) console.error(error.message);
  console.error(JSON.stringify({ ok: false, stage, error: 'Disposable identity acceptance failed; no credentials or raw provider output emitted.' }));
  for (const name of names) {
    try {
      const state = docker('inspect', '--format', '{{.State.Status}} exit={{.State.ExitCode}} error={{.State.Error}}', name);
      const output = execFileSync('docker', ['logs', '--tail', '60', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const redacted = syntheticSecrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), output);
      const diagnostics = redacted.split('\n').filter(line => /ERROR|WARN|error|failed|Listening|started/i.test(line)).map(line => line.slice(0, 500));
      console.error(JSON.stringify({ container: name, state, diagnostics }));
    } catch {}
  }
  process.exitCode = 1;
} finally {
  if (browsers) await browsers.close();
  for (const name of names.reverse()) { try { docker('rm', '-f', '-v', name); } catch {} }
  for (const name of privateNetworks) { try { docker('network', 'rm', name); } catch {} }
  if (networkCreated) { try { docker('network', 'rm', prefix); } catch {} }
  setDefaultCACertificates(originalTrust);
  rmSync(root, { recursive: true, force: true });
}

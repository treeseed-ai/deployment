// Two typed, independent BFF applications used only for protocol acceptance.
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { importPKCS8 } from 'jose';
import { chromium } from 'playwright';
import { createBrowserOidcClient, type LoginTransaction } from '@treeseed/identity';
import { nativeFixture } from './native.js';
import { cliFixture } from './cli.js';
type OidcClient = Awaited<ReturnType<typeof createBrowserOidcClient>>;
type App = { base: string; server: ReturnType<typeof createServer>; failure: () => string | undefined;
  descriptor: Record<string, unknown>; initialize: (issuer: string) => Promise<void> };

export async function browserFixture(root: string) {
  const cli = await cliFixture(root);
  const native = await nativeFixture(cli.resource);
  const tls = { key: readFileSync(join(root, 'tls/key.pem')), cert: readFileSync(join(root, 'tls/cert.pem')) };
  const pin = createHash('sha256').update(new X509Certificate(tls.cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const apps: App[] = [];
  for (const name of ['admin', 'market']) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${name}-client`,
      '-keyout', join(root, `${name}.key`), '-out', join(root, `${name}.crt`)], { stdio: 'ignore' });
    const privateKey = await importPKCS8(readFileSync(join(root, `${name}.key`), 'utf8'), 'RS256');
    const certificate = readFileSync(join(root, `${name}.crt`), 'utf8').replace(/-----[^-]+-----|\s/g, '');
    const transactions = new Map<string, LoginTransaction>(), sessions = new Map<string, Awaited<ReturnType<OidcClient['finish']>>>();
    const cookie = (request: IncomingMessage, key: string) => (request.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(`${key}=`))?.slice(key.length + 1) ?? '';
    const setCookie = (response: ServerResponse, key: string, value: string) => response.setHeader('Set-Cookie', `${key}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax`);
    let client: OidcClient | undefined, base = '', failure: string | undefined;
    const server = createServer(tls, async (request, response) => {
      try {
        assert.ok(client);
        const url = new URL(request.url ?? '/', base);
        if (url.pathname === '/login') {
          const binding = randomBytes(32).toString('hex'); setCookie(response, '__Host-login', binding);
          response.writeHead(302, { Location: await client.begin(binding) }); response.end();
        } else if (url.pathname === '/callback') {
          const result = await client.finish(cookie(request, '__Host-login'), url);
          const id = randomBytes(32).toString('hex'); sessions.set(id, result);
          setCookie(response, '__Host-session', id); response.writeHead(302, { Location: '/me' }); response.end();
        } else if (url.pathname === '/me') {
          const session = sessions.get(cookie(request, '__Host-session'));
          response.writeHead(session ? 200 : 401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          response.end(JSON.stringify(session ? { app: name, subject: session.identity.subject } : { authenticated: false }));
        } else { response.writeHead(404); response.end(); }
      } catch (error) { failure = error instanceof Error && 'code' in error ? String(error.code) : 'browser-fixture-failed'; response.writeHead(500); response.end('Login failed'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    base = `https://${name}.localhost:${address.port}`;
    const redirectUri = `${base}/callback`;
    apps.push({ base, server, failure: () => failure, descriptor: { clientId: name, enabled: true, protocol: 'openid-connect', publicClient: false,
      clientAuthenticatorType: 'client-jwt', attributes: { 'jwt.credential.certificate': certificate, 'token.endpoint.auth.signing.alg': 'RS256', 'pkce.code.challenge.method': 'S256' },
      standardFlowEnabled: true, directAccessGrantsEnabled: false, serviceAccountsEnabled: false, redirectUris: [redirectUri], webOrigins: [] },
      async initialize(issuer: string) { client = await createBrowserOidcClient({ issuer, clientId: name, redirectUri, privateKey, transport: fetch,
        store: {
          async put(binding, transaction) { transactions.set(`${binding}:${transaction.state}`, transaction); },
          async consume(binding, state) { const key = `${binding}:${state}`; const value = transactions.get(key); transactions.delete(key); return value ?? null; },
        } }); },
    });
  }
  const [admin, market] = apps; assert.ok(admin && market);
  return {
    clients: [...apps.map(app => app.descriptor), native.descriptor],
    async verifyFederation(localIssuer: string, remoteIssuer: string, password: string) {
      for (const app of apps) await app.initialize(localIssuer);
      const browser = await chromium.launch({ args: [`--ignore-certificate-errors-spki-list=${pin}`, '--host-resolver-rules=MAP *.localhost 127.0.0.1'] });
      let phase = 'provider-selection';
      const context = await browser.newContext(); const page = await context.newPage(); page.setDefaultTimeout(20_000);
      try {
        await page.goto(`${admin.base}/login`);
        await page.getByRole('link', { name: 'Explicit central trust' }).click();
        phase = 'remote-login';
        await page.locator('input[name="username"]').fill('central-user');
        await page.locator('input[name="password"]').fill(password);
        await page.locator('input[name="login"],button[name="login"]').click();
        phase = 'broker-callback';
        await page.waitForURL(`${admin.base}/me`);
        assert.ok(JSON.parse(await page.locator('body').innerText()).subject);
        phase = 'reverse-trust-denial';
        const reverse = new URL(`${remoteIssuer}/protocol/openid-connect/auth`);
        reverse.search = new URLSearchParams({ client_id: 'admin', redirect_uri: `${admin.base}/callback`, response_type: 'code', scope: 'openid',
          state: randomBytes(32).toString('hex'), nonce: randomBytes(32).toString('hex'), code_challenge: randomBytes(32).toString('base64url'), code_challenge_method: 'S256', kc_idp_hint: 'sovereign' }).toString();
        // Use an empty browser session: a central SSO cookie must not bypass this negative.
        const isolated = await browser.newContext(); const negative = await isolated.newPage();
        const response = await negative.goto(reverse.href);
        assert.ok(response);
        // An unknown optional hint falls back to local login, not a reverse trust grant.
        assert.equal(response.status(), 200);
        assert.equal(new URL(negative.url()).origin, new URL(remoteIssuer).origin);
        assert.equal(new URL(negative.url()).searchParams.has('code'), false);
        assert.equal(await negative.locator('input[name="username"]').isVisible(), true);
        assert.equal(await negative.locator('a[href*="/broker/sovereign/"]').count(), 0);
        const absentBroker = await negative.goto(`${remoteIssuer}/broker/sovereign/endpoint`);
        assert.ok(absentBroker);
        assert.ok(absentBroker.status() >= 400 && absentBroker.status() < 500);
        return ['explicit-directional-broker-login', 'reverse-trust-not-inferred'];
      } catch {
        console.error(JSON.stringify({ federationPhase: phase, path: new URL(page.url()).pathname,
          fields: await page.locator('input[name]').evaluateAll(inputs => inputs.map(input => input.getAttribute('name'))),
          serverFailures: apps.map(app => app.failure() ?? null) }));
        throw new Error('Federation acceptance failed');
      }
      finally { await browser.close(); }
    },
    async verify(issuer: string, password: string) {
      let phase = 'initialize';
      for (const app of apps) await app.initialize(issuer);
      const browser = await chromium.launch({ args: [`--ignore-certificate-errors-spki-list=${pin}`, '--host-resolver-rules=MAP *.localhost 127.0.0.1'] });
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        page.setDefaultTimeout(20_000);
        await page.goto(`${admin.base}/login`);
        phase = 'first-login-form';
        await page.locator('input[name="username"]').fill('acceptance-user');
        await page.locator('input[name="password"]').fill(password);
        await page.locator('input[name="login"],button[name="login"]').click();
        phase = 'first-callback';
        await page.waitForURL(`${admin.base}/me`);
        const first = JSON.parse(await page.locator('body').innerText());
        assert.ok(first.subject);
        const unauthorized = await page.goto(`${market.base}/me`); assert.ok(unauthorized);
        assert.equal(unauthorized.status(), 401);
        await page.goto(`${market.base}/login`);
        phase = 'second-callback';
        // No second credential entry: Keycloak SSO, never shared application cookies.
        await page.waitForURL(`${market.base}/me`);
        assert.equal(JSON.parse(await page.locator('body').innerText()).subject, first.subject);
        const cookies = (await context.cookies()).filter(c => c.name === '__Host-session');
        phase = 'cookie-isolation';
        assert.equal(cookies.length, 2);
        assert.deepEqual(cookies.map(c => c.domain).sort(), ['admin.localhost', 'market.localhost']);
        assert.notEqual(cookies[0]!.value, cookies[1]!.value);
        assert.ok(cookies.every(c => c.secure && c.httpOnly && c.sameSite === 'Lax'));
        for (const app of apps) {
          await page.goto(`${app.base}/me`);
          assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
          assert.equal(await page.evaluate(() => document.cookie.includes('__Host-session')), false);
        }
        phase = 'native-cli-sso';
        const nativeChecks = await native.verify(issuer, context, first.subject);
        phase = 'published-cli-sso';
        const cliChecks = await cli.verify(issuer, context, first.subject);
        return ['human-login-with-central-offline', 'two-client-sso', 'host-only-independent-sessions', 'no-browser-token-storage', ...nativeChecks, ...cliChecks];
      } catch { console.error(JSON.stringify({ browserPhase: phase, serverFailures: apps.map(app => app.failure() ?? null) })); throw new Error('Browser acceptance failed'); }
      finally { await browser.close(); }
    },
    async close() { await native.close(); await cli.close(); for (const app of apps) await new Promise<void>(resolve => app.server.close(() => resolve())); },
  };
}

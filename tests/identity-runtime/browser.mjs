// Two minimal, independent BFF applications used only for protocol acceptance.
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { randomBytes, createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { importPKCS8 } from 'jose';
import { chromium } from 'playwright';
import { createBrowserOidcClient } from '@treeseed/identity';

export async function browserFixture(root) {
  const tls = { key: readFileSync(join(root, 'tls/key.pem')), cert: readFileSync(join(root, 'tls/cert.pem')) };
  const pin = createHash('sha256').update(new X509Certificate(tls.cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const apps = [];
  for (const name of ['admin', 'market']) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${name}-client`,
      '-keyout', join(root, `${name}.key`), '-out', join(root, `${name}.crt`)], { stdio: 'ignore' });
    const privateKey = await importPKCS8(readFileSync(join(root, `${name}.key`), 'utf8'), 'RS256');
    const certificate = readFileSync(join(root, `${name}.crt`), 'utf8').replace(/-----[^-]+-----|\s/g, '');
    const transactions = new Map(), sessions = new Map();
    const cookie = (request, key) => (request.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(`${key}=`))?.slice(key.length + 1) ?? '';
    const setCookie = (response, key, value) => response.setHeader('Set-Cookie', `${key}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax`);
    let client, base, failure;
    const server = createServer(tls, async (request, response) => {
      try {
        const url = new URL(request.url, base);
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
      } catch (error) { failure = error.code ?? 'browser-fixture-failed'; response.writeHead(500); response.end('Login failed'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `https://${name}.localhost:${server.address().port}`;
    const redirectUri = `${base}/callback`;
    apps.push({ base, server, failure: () => failure, descriptor: { clientId: name, enabled: true, protocol: 'openid-connect', publicClient: false,
      clientAuthenticatorType: 'client-jwt', attributes: { 'jwt.credential.certificate': certificate, 'token.endpoint.auth.signing.alg': 'RS256', 'pkce.code.challenge.method': 'S256' },
      standardFlowEnabled: true, directAccessGrantsEnabled: false, serviceAccountsEnabled: false, redirectUris: [redirectUri], webOrigins: [] },
      async initialize(issuer) { client = await createBrowserOidcClient({ issuer, clientId: name, redirectUri, privateKey, transport: fetch,
        store: {
          async put(binding, transaction) { transactions.set(`${binding}:${transaction.state}`, transaction); },
          async consume(binding, state) { const key = `${binding}:${state}`; const value = transactions.get(key); transactions.delete(key); return value ?? null; },
        } }); },
    });
  }
  return {
    clients: apps.map(app => app.descriptor),
    async verifyFederation(localIssuer, remoteIssuer, password) {
      for (const app of apps) await app.initialize(localIssuer);
      const browser = await chromium.launch({ args: [`--ignore-certificate-errors-spki-list=${pin}`, '--host-resolver-rules=MAP *.localhost 127.0.0.1'] });
      let phase = 'provider-selection';
      try {
        const context = await browser.newContext(); const page = await context.newPage(); page.setDefaultTimeout(20_000);
        await page.goto(`${apps[0].base}/login`);
        await page.getByRole('link', { name: 'Explicit central trust' }).click();
        phase = 'remote-login';
        await page.locator('input[name="username"]').fill('central-user');
        await page.locator('input[name="password"]').fill(password);
        await page.locator('input[name="login"],button[name="login"]').click();
        phase = 'broker-callback';
        await page.waitForURL(`${apps[0].base}/me`);
        assert.ok(JSON.parse(await page.locator('body').innerText()).subject);
        phase = 'reverse-trust-denial';
        const reverse = new URL(`${remoteIssuer}/protocol/openid-connect/auth`);
        reverse.search = new URLSearchParams({ client_id: 'admin', redirect_uri: `${apps[0].base}/callback`, response_type: 'code', scope: 'openid',
          state: randomBytes(32).toString('hex'), nonce: randomBytes(32).toString('hex'), code_challenge: randomBytes(32).toString('base64url'), code_challenge_method: 'S256', kc_idp_hint: 'sovereign' }).toString();
        // Use an empty browser session: a central SSO cookie must not bypass this negative.
        const isolated = await browser.newContext(); const negative = await isolated.newPage();
        const response = await negative.goto(reverse.href);
        // An unknown optional hint falls back to local login, not a reverse trust grant.
        assert.equal(response.status(), 200);
        assert.equal(new URL(negative.url()).origin, new URL(remoteIssuer).origin);
        assert.equal(new URL(negative.url()).searchParams.has('code'), false);
        assert.equal(await negative.locator('input[name="username"]').isVisible(), true);
        assert.equal(await negative.locator('a[href*="/broker/sovereign/"]').count(), 0);
        const absentBroker = await negative.goto(`${remoteIssuer}/broker/sovereign/endpoint`);
        assert.ok(absentBroker.status() >= 400 && absentBroker.status() < 500);
        return ['explicit-directional-broker-login', 'reverse-trust-not-inferred'];
      } catch { console.error(JSON.stringify({ federationPhase: phase, serverFailures: apps.map(app => app.failure() ?? null) })); throw new Error('Federation acceptance failed'); }
      finally { await browser.close(); }
    },
    async verify(issuer, password) {
      let phase = 'initialize';
      for (const app of apps) await app.initialize(issuer);
      const browser = await chromium.launch({ args: [`--ignore-certificate-errors-spki-list=${pin}`, '--host-resolver-rules=MAP *.localhost 127.0.0.1'] });
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        page.setDefaultTimeout(20_000);
        await page.goto(`${apps[0].base}/login`);
        phase = 'first-login-form';
        await page.locator('input[name="username"]').fill('acceptance-user');
        await page.locator('input[name="password"]').fill(password);
        await page.locator('input[name="login"],button[name="login"]').click();
        phase = 'first-callback';
        await page.waitForURL(`${apps[0].base}/me`);
        const first = JSON.parse(await page.locator('body').innerText());
        assert.ok(first.subject);
        assert.equal((await page.goto(`${apps[1].base}/me`)).status(), 401);
        await page.goto(`${apps[1].base}/login`);
        phase = 'second-callback';
        // No second credential entry: Keycloak SSO, never shared application cookies.
        await page.waitForURL(`${apps[1].base}/me`);
        assert.equal(JSON.parse(await page.locator('body').innerText()).subject, first.subject);
        const cookies = (await context.cookies()).filter(c => c.name === '__Host-session');
        phase = 'cookie-isolation';
        assert.equal(cookies.length, 2);
        assert.deepEqual(cookies.map(c => c.domain).sort(), ['admin.localhost', 'market.localhost']);
        assert.notEqual(cookies[0].value, cookies[1].value);
        assert.ok(cookies.every(c => c.secure && c.httpOnly && c.sameSite === 'Lax'));
        for (const app of apps) {
          await page.goto(`${app.base}/me`);
          assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
          assert.equal(await page.evaluate(() => document.cookie.includes('__Host-session')), false);
        }
        return ['human-login-with-central-offline', 'two-client-sso', 'host-only-independent-sessions', 'no-browser-token-storage'];
      } catch { console.error(JSON.stringify({ browserPhase: phase, serverFailures: apps.map(app => app.failure() ?? null) })); throw new Error('Browser acceptance failed'); }
      finally { await browser.close(); }
    },
    async close() { for (const app of apps) await new Promise(resolve => app.server.close(resolve)); },
  };
}

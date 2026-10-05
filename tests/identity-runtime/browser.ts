// Two typed, independent BFF applications used only for protocol acceptance.
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { randomBytes, createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { importPKCS8 } from 'jose';
import { chromium } from 'playwright';
import { createApplicationSession } from '@treeseed/identity';
import { BROWSER_SESSION_SCOPE } from '@treeseed/sdk/identity';
import { apiSessions } from './api-sessions.js';
import { nativeFixture } from './native.js';
import { cliFixture } from './cli.js';
type Application = ReturnType<typeof createApplicationSession>;
type App = { base: string; server: ReturnType<typeof createServer>; failure: () => string | undefined;
  descriptors: Record<string, unknown>[]; initialize: (issuer: string) => Promise<void> };

export async function browserFixture(root: string) {
  const api = await apiSessions(root);
  const cli = await cliFixture(root);
  const native = await nativeFixture(cli.resource);
  const tls = { key: readFileSync(join(root, 'tls/key.pem')), cert: readFileSync(join(root, 'tls/cert.pem')) };
  const pin = createHash('sha256').update(new X509Certificate(tls.cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const apps: App[] = [];
  for (const name of ['admin', 'market']) {
    for (const client of [name, `${name}-bff`]) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${client}-client`,
      '-keyout', join(root, `${client}.key`), '-out', join(root, `${client}.crt`)], { stdio: 'ignore' });
    const privateKey = await importPKCS8(readFileSync(join(root, `${name}.key`), 'utf8'), 'RS256');
    const certificate = readFileSync(join(root, `${name}.crt`), 'utf8').replace(/-----[^-]+-----|\s/g, '');
    const workloadKey = await importPKCS8(readFileSync(join(root, `${name}-bff.key`), 'utf8'), 'RS256');
    const workloadCertificate = readFileSync(join(root, `${name}-bff.crt`), 'utf8').replace(/-----[^-]+-----|\s/g, '');
    let client: Application | undefined, base = '', failure: string | undefined;
    const server = createServer(tls, async (request, response) => {
      try {
        assert.ok(client);
        const url = new URL(request.url ?? '/', base);
        const input = new Request(url, { method: request.method ?? 'GET', headers: { cookie: request.headers.cookie ?? '', ...(request.headers.origin ? { origin: request.headers.origin } : {}) } });
        let result: Response;
        if (url.pathname === '/login') {
          result = await client.login(input);
        } else if (url.pathname === '/callback') {
          result = await client.callback(input);
        } else if (url.pathname === '/logout') {
          result = await client.logout(input);
        } else if (url.pathname === '/me') {
          const session = await client.session(input);
          if (session) {
            const status = await fetch(`${api.resource}/v1/status`, { headers: { authorization: `Bearer ${session.accessToken}` } });
            assert.equal(status.status, 200, 'BFF session must authorize a real API resource operation');
          }
          result = Response.json(session ? { app: name, subject: session.principal.identity.subject } : { authenticated: false },
            { status: session ? 200 : 401, headers: { 'cache-control': 'no-store' } });
        } else { result = new Response(null, { status: 404 }); }
        result.headers.forEach((value, key) => { if (key !== 'set-cookie') response.setHeader(key, value); });
        if (result.headers.getSetCookie().length) response.setHeader('set-cookie', result.headers.getSetCookie());
        response.writeHead(result.status); response.end(Buffer.from(await result.arrayBuffer()));
      } catch (error) { failure = error instanceof Error && 'code' in error ? String(error.code) : 'browser-fixture-failed'; response.writeHead(500); response.end('Login failed'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    base = `https://${name}.localhost:${address.port}`;
    const redirectUri = `${base}/callback`;
    const audience = [{ name: 'api-audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper',
      config: { 'included.custom.audience': api.resource, 'access.token.claim': 'true' } }];
    apps.push({ base, server, failure: () => failure, descriptors: [{ clientId: name, enabled: true, protocol: 'openid-connect', publicClient: false,
      clientAuthenticatorType: 'client-jwt', attributes: { 'jwt.credential.certificate': certificate, 'token.endpoint.auth.signing.alg': 'RS256', 'pkce.code.challenge.method': 'S256' },
      standardFlowEnabled: true, directAccessGrantsEnabled: false, serviceAccountsEnabled: false, redirectUris: [redirectUri], webOrigins: [],
      defaultClientScopes: ['basic','profile','email'], optionalClientScopes: ['treeseed:read'], protocolMappers: audience },
      { clientId: `${name}-bff`, enabled: true, protocol: 'openid-connect', publicClient: false, clientAuthenticatorType: 'client-jwt',
        attributes: { 'jwt.credential.certificate': workloadCertificate, 'token.endpoint.auth.signing.alg': 'RS256' },
        standardFlowEnabled: false, directAccessGrantsEnabled: false, serviceAccountsEnabled: true, defaultClientScopes: ['basic'],
        optionalClientScopes: [BROWSER_SESSION_SCOPE], protocolMappers: audience }],
      async initialize(issuer: string) { client = await api.application({ issuer, name, callback: redirectUri, browserKey: privateKey, workloadKey }); },
    });
  }
  const [admin, market] = apps; assert.ok(admin && market);
  return {
    clients: [...apps.flatMap(app => app.descriptors), native.descriptor],
    provision: api.provision,
    migrateAccount: api.migrateAccount,
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
        // Inspect native form navigation within one pending BFF authorization.
        // Repeated /login calls create intentionally unconsumed PKCE records.
        const authorizationUrl = page.url();
        await page.screenshot({ path: 'identity-auth-desktop.png', fullPage: true });
        assert.equal(await page.locator('.auth-brand__name').innerText(), 'TreeSeed');
        phase = 'theme-favicon';
        const favicon = await page.locator('link[rel="icon"]').getAttribute('href');
        assert.ok(favicon);
        assert.ok(favicon?.endsWith('/img/treeseed-logo.svg'));
        // Use the browser's explicitly pinned TLS context, not Playwright's
        // separate API request client (which does not inherit Chromium pins).
        assert.equal(await page.evaluate(async href => (await fetch(href, { credentials: 'omit' })).status, favicon), 200);
        phase = 'theme-password-reset';
        await page.getByRole('link', { name: 'Forgot password?' }).click();
        await page.locator('input[name="username"]').waitFor();
        assert.match(await page.locator('#kc-page-title').innerText(), /Reset your password/);
        await page.goto(authorizationUrl);
        phase = 'theme-registration';
        await page.getByRole('link', { name: 'Create account' }).click();
        assert.match(await page.locator('#kc-page-title').innerText(), /Create your TreeSeed account/);
        await page.goto(authorizationUrl);
        phase = 'theme-responsive-layout';
        await page.screenshot({ path: 'identity-auth-desktop.png', fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: 'identity-auth-mobile.png', fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        await page.setViewportSize({ width: 1280, height: 720 });
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
        const cliChecks = await cli.verify(issuer, context, first.subject, password);
        phase = 'api-session-storage';
        const storageChecks = await api.verifyStorage(cookies.map(cookie => cookie.value));
        return ['human-login-with-central-offline', 'two-client-sso', 'host-only-independent-sessions', 'no-browser-token-storage', ...nativeChecks, ...cliChecks, ...storageChecks];
      } catch { console.error(JSON.stringify({ browserPhase: phase, serverFailures: apps.map(app => app.failure() ?? null) })); throw new Error('Browser acceptance failed'); }
      finally { await browser.close(); }
    },
    async close() { await native.close(); await cli.close(); for (const app of apps) await new Promise<void>(resolve => app.server.close(() => resolve())); await api.close(); },
  };
}

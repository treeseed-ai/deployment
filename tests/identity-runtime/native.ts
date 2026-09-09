import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { BrowserContext } from 'playwright';
import { createLocalJWKSet } from 'jose';
import { createNativeOidcClient, createPublicSessionClient } from '@treeseed/identity';

type Pending = Awaited<ReturnType<Awaited<ReturnType<typeof createNativeOidcClient>>['begin']>>;
type Result = Awaited<ReturnType<Pending['finish']>>;

export async function nativeFixture(resource: string) {
  let pending: Pending | undefined, receive: ((result: Result | null) => void) | undefined, redirectUri = '';
  const server = createServer(async (request, response) => {
    try {
      const target = new URL(redirectUri);
      if (!pending || request.method !== 'GET' || request.headers.host !== target.host) throw new Error();
      const result = await pending.finish(new URL(request.url ?? '/', redirectUri));
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); response.end('Sign-in complete.');
      receive?.(result);
    } catch { response.writeHead(400); response.end('Sign-in failed.'); receive?.(null); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  redirectUri = `http://127.0.0.1:${address.port}/callback`;
  return {
    descriptor: { clientId: 'trsd', enabled: true, protocol: 'openid-connect', publicClient: true,
      standardFlowEnabled: true, directAccessGrantsEnabled: false, serviceAccountsEnabled: false,
      defaultClientScopes: ['basic'],
      // Keycloak's native loopback registration ignores the ephemeral port,
      // while preserving the exact path. No host/path wildcard.
      redirectUris: ['http://127.0.0.1/callback'], webOrigins: [], optionalClientScopes: ['treeseed:read','treeseed:knowledge:write','treeseed:governance:write','treeseed:projects:write','treeseed:execution'], attributes: { 'pkce.code.challenge.method': 'S256' },
      protocolMappers: [{ name: 'api-audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper',
        config: { 'included.custom.audience': resource, 'access.token.claim': 'true' } }] },
    async verify(issuer: string, context: BrowserContext, expectedSubject: string, login?: { username: string; password: string }) {
      const discovery = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json();
      const keys = createLocalJWKSet(await (await fetch(discovery.jwks_uri)).json());
      const options = { issuer, clientId: 'trsd', resource, scopes: [], profile: 'keycloak' as const, transport: fetch,
        verificationKey: keys, resolvePrincipal: async (identity: { subject: string }) => ({ principalId: identity.subject, kind: 'human' as const }) };
      const client = await createNativeOidcClient({ ...options, redirectUri });
      pending = await client.begin();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const completed = new Promise<Result | null>(resolve => { receive = resolve; timer = setTimeout(() => resolve(null), 20_000); });
      const page = await context.newPage();
      try {
        // Reuse the browser's existing Identity session, not either application's cookie.
        await page.goto(pending.authorizationUrl);
        if (login) {
          await page.locator('input[name="username"]').fill(login.username);
          await page.locator('input[name="password"]').fill(login.password);
          await page.locator('input[name="login"],button[name="login"]').click();
          await page.locator('[name="accept"]').click();
        }
        const result = await completed; assert.ok(result);
        assert.equal(result.principal.identity.subject, expectedSubject);
        assert.equal(new URL(page.url()).origin, new URL(redirectUri).origin);
        assert.ok(result.tokens.refresh_token);
        const session = await createPublicSessionClient(options);
        const renewed = await session.refresh(result.tokens.refresh_token, result.principal.identity);
        assert.equal(renewed.principal.identity.subject, expectedSubject);
        const refreshToken = renewed.tokens.refresh_token ?? result.tokens.refresh_token;
        await session.revoke(refreshToken);
        await assert.rejects(session.refresh(refreshToken, result.principal.identity));
        return [login ? 'native-cli-first-login' : 'native-cli-sso-without-second-login', 'native-loopback-pkce', 'native-public-refresh', 'native-public-revocation'];
      } finally { if (timer) clearTimeout(timer); pending.cancel(); pending = undefined; receive = undefined; await page.close(); }
    },
    async close() { await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

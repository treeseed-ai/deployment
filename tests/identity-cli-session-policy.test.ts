import { expect, it, vi } from 'vitest';
import { reconcileCliSessionPolicy } from '../src/identity/cli-session-policy.js';

function fixture(overrides: Record<string, unknown> = {}) {
  let realm = { ssoSessionIdleTimeout: 1800, ssoSessionMaxLifespan: 36000, clientSessionIdleTimeout: 0, clientSessionMaxLifespan: 0,
    unrelated: 'keep', ...overrides };
  let client = { clientId: 'trsd', publicClient: true, enabled: true, webOrigins: [] as string[], redirectUris: ['http://127.0.0.1/callback'],
    attributes: { 'treeseed.managed-by': 'treeseed-deployment', 'pkce.code.challenge.method': 'S256', 'access.token.lifespan': '300' } };
  const transport = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.redirect).toBe('error');
    const isClient = url.endsWith('/clients/client-id');
    if (init.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      if (isClient) client = { ...client, ...body, webOrigins: body.webOrigins ?? ['http://127.0.0.1'] }; else realm = { ...realm, ...body };
      return new Response(null, { status: 204 });
    }
    return Response.json(isClient ? client : realm);
  });
  return { input: { resource: 'https://identity.example/admin/realms/treeseed', clientId: 'client-id', token: 'synthetic', transport: transport as typeof fetch },
    transport, realm: () => realm, client: () => client };
}
it('extends CLI to 24h, retains five-minute tokens and other client limits, and repeats noop', async () => {
  const f = fixture();
  expect(await reconcileCliSessionPolicy(f.input)).toMatchObject({ action: 'updated', sessionMaxSeconds: 86400, accessTokenSeconds: 300 });
  expect(f.realm()).toMatchObject({ ssoSessionIdleTimeout: 86400, ssoSessionMaxLifespan: 86400, clientSessionIdleTimeout: 1800, clientSessionMaxLifespan: 36000, unrelated: 'keep' });
  expect(f.client()).toMatchObject({ redirectUris: ['http://127.0.0.1/callback'], attributes: { 'pkce.code.challenge.method': 'S256', 'client.session.idle.timeout': '86400', 'client.session.max.lifespan': '86400' } });
  expect(await reconcileCliSessionPolicy(f.input)).toMatchObject({ action: 'noop' });
  expect(f.client().webOrigins).toEqual([]);
  expect(f.transport.mock.calls.filter(([, init]) => init.method === 'PUT')).toHaveLength(2);
});
it('does not shorten preexisting SSO policy or change explicit other-client defaults', async () => {
  const f = fixture({ ssoSessionIdleTimeout: 172800, ssoSessionMaxLifespan: 172800, clientSessionIdleTimeout: 900, clientSessionMaxLifespan: 7200 });
  await reconcileCliSessionPolicy(f.input);
  expect(f.realm()).toMatchObject({ ssoSessionIdleTimeout: 172800, ssoSessionMaxLifespan: 172800, clientSessionIdleTimeout: 900, clientSessionMaxLifespan: 7200 });
});
it('materializes Keycloak defaults for a new realm', async () => {
  const f = fixture({ ssoSessionIdleTimeout: undefined, ssoSessionMaxLifespan: undefined });
  await reconcileCliSessionPolicy(f.input);
  expect(f.realm()).toMatchObject({ clientSessionIdleTimeout: 1800, clientSessionMaxLifespan: 36000 });
});
it('rejects unmanaged clients without any writes', async () => {
  const f = fixture(); f.client().attributes['treeseed.managed-by'] = 'other';
  await expect(reconcileCliSessionPolicy(f.input)).rejects.toThrow('managed trsd');
  expect(f.transport.mock.calls.some(([, init]) => init.method === 'PUT')).toBe(false);
});
it('fails closed when provider ignores updates', async () => {
  const f = fixture(); const original = f.input.transport;
  f.input.transport = ((url, init) => init?.method === 'PUT' ? Promise.resolve(new Response(null, { status: 204 })) : original(url, init)) as typeof fetch;
  await expect(reconcileCliSessionPolicy(f.input)).rejects.toThrow('read-back differs');
});
it.each([-1, NaN, '86400'])('rejects malformed parent lifetime %s', async value => {
  const f = fixture({ ssoSessionMaxLifespan: value });
  await expect(reconcileCliSessionPolicy(f.input)).rejects.toThrow();
});

import { expect, it, vi } from 'vitest';
import { reconcileCliSessionPolicy } from '../src/identity/cli-session-policy.js';

function fixture(overrides: Record<string, unknown> = {}) {
  let realm = { ssoSessionIdleTimeout: 1800, ssoSessionMaxLifespan: 36000, clientSessionIdleTimeout: 0, clientSessionMaxLifespan: 0,
    unrelated: 'keep', ...overrides };
  let client = { clientId: 'trsd', publicClient: true, enabled: true, webOrigins: [] as string[], redirectUris: ['http://127.0.0.1/callback'],
    attributes: { 'treeseed.managed-by': 'treeseed-deployment', 'pkce.code.challenge.method': 'S256', 'access.token.lifespan': '300' } };
  let offline = { id: 'offline-id', name: 'offline_access', protocol: 'openid-connect', description: 'Existing realm scope',
    attributes: { 'include.in.openid.provider.metadata': 'false', 'include.in.token.scope': 'true' }, protocolMappers: [] };
  const transport = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.redirect).toBe('error');
    const isClient = url.endsWith('/clients/client-id');
    if (url.endsWith('/client-scopes')) return Response.json([offline]);
    if (url.endsWith('/client-scopes/offline-id')) {
      if (init.method === 'PUT') { offline = JSON.parse(String(init.body)); return new Response(null, { status: 204 }); }
      return Response.json(offline);
    }
    if (init.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      if (isClient) client = { ...client, ...body, webOrigins: body.webOrigins ?? ['http://127.0.0.1'] }; else realm = { ...realm, ...body };
      return new Response(null, { status: 204 });
    }
    return Response.json(isClient ? client : realm);
  });
  return { input: { resource: 'https://identity.example/admin/realms/treeseed', clientId: 'client-id', token: 'synthetic', transport: transport as typeof fetch },
    transport, realm: () => realm, client: () => client, offline: () => offline };
}
it('does not advertise unavailable offline grants to native MCP clients or alter the underlying scope', async () => {
  const f = fixture();
  f.offline().attributes['include.in.openid.provider.metadata'] = 'true';
  const before = structuredClone(f.offline());
  await reconcileCliSessionPolicy(f.input);
  expect(f.offline()).toEqual({ ...before, attributes: { ...before.attributes, 'include.in.openid.provider.metadata': 'false' } });
  const writes = f.transport.mock.calls.filter(([url, init]) => url.endsWith('/client-scopes/offline-id') && init.method === 'PUT');
  expect(writes).toHaveLength(1);
  await reconcileCliSessionPolicy(f.input);
  expect(f.transport.mock.calls.filter(([url, init]) => url.endsWith('/client-scopes/offline-id') && init.method === 'PUT')).toHaveLength(1);
  expect(f.client()).toMatchObject({ publicClient: true, attributes: { 'access.token.lifespan': '300' } });
});
it('rejects an ignored discovery update rather than reporting renewal repaired', async () => {
  const f = fixture(); f.offline().attributes['include.in.openid.provider.metadata'] = 'true';
  const original = f.input.transport;
  f.input.transport = ((url, init) => String(url).endsWith('/client-scopes/offline-id') && init?.method === 'PUT'
    ? Promise.resolve(new Response(null, { status: 204 })) : original(url, init)) as typeof fetch;
  await expect(reconcileCliSessionPolicy(f.input)).rejects.toThrow('discovery read-back differs');
  expect(f.offline().attributes['include.in.openid.provider.metadata']).toBe('true');
});
it.each([{}, [null], [{ id: '../unsafe', name: 'offline_access' }]])('denies malformed scope inventory %j', async inventory => {
  const f = fixture(), original = f.input.transport;
  f.input.transport = ((url, init) => String(url).endsWith('/client-scopes')
    ? Promise.resolve(Response.json(inventory)) : original(url, init)) as typeof fetch;
  await expect(reconcileCliSessionPolicy(f.input)).rejects.toThrow();
  expect(f.transport.mock.calls.some(([url, init]) => url.includes('/client-scopes/') && init.method === 'PUT')).toBe(false);
});
it('extends CLI to one week, retains five-minute tokens and other client limits, and repeats noop', async () => {
  const f = fixture();
  expect(await reconcileCliSessionPolicy(f.input)).toMatchObject({ action: 'updated', sessionMaxSeconds: 604800, accessTokenSeconds: 300 });
  expect(f.realm()).toMatchObject({ ssoSessionIdleTimeout: 604800, ssoSessionMaxLifespan: 604800, clientSessionIdleTimeout: 1800, clientSessionMaxLifespan: 36000, unrelated: 'keep' });
  expect(f.client()).toMatchObject({ redirectUris: ['http://127.0.0.1/callback'], attributes: { 'pkce.code.challenge.method': 'S256', 'client.session.idle.timeout': '604800', 'client.session.max.lifespan': '604800' } });
  expect(await reconcileCliSessionPolicy(f.input)).toMatchObject({ action: 'noop' });
  expect(f.client().webOrigins).toEqual([]);
  expect(f.transport.mock.calls.filter(([, init]) => init.method === 'PUT')).toHaveLength(2);
});
it('does not shorten preexisting SSO policy or change explicit other-client defaults', async () => {
  const f = fixture({ ssoSessionIdleTimeout: 1209600, ssoSessionMaxLifespan: 1209600, clientSessionIdleTimeout: 900, clientSessionMaxLifespan: 7200 });
  await reconcileCliSessionPolicy(f.input);
  expect(f.realm()).toMatchObject({ ssoSessionIdleTimeout: 1209600, ssoSessionMaxLifespan: 1209600, clientSessionIdleTimeout: 900, clientSessionMaxLifespan: 7200 });
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

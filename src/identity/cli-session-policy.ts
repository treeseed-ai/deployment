/** Finite CLI login, not a 24-hour bearer token. Other clients retain their
 * effective realm defaults when the shared SSO parent is extended. */
export const CLI_SESSION_SECONDS = 86_400;
export async function reconcileCliSessionPolicy(options: {
  resource: string; clientId: string; token: string; transport: typeof fetch;
}) {
  if (!/^[A-Za-z0-9-]{1,128}$/u.test(options.clientId)) throw new Error('Invalid managed CLI client identity');
  const request = async (suffix: string, method = 'GET', body?: unknown): Promise<Record<string, any>> => {
    const response = await options.transport(`${options.resource}${suffix}`, { method, redirect: 'error', credentials: 'omit',
      signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${options.token}`, accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.redirected || !response.ok) { await response.body?.cancel(); throw new Error('CLI session policy request failed'); }
    if (method === 'PUT') { await response.body?.cancel(); return {}; }
    const reader = response.body?.getReader(); if (!reader) throw new Error('CLI session policy read-back missing');
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length; if (size > 1_048_576) throw new Error('CLI session policy response exceeds limit'); chunks.push(chunk.value);
    } } finally { await reader.cancel(); reader.releaseLock(); }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid CLI session policy response');
    return value as Record<string, any>;
  };
  const path = `/clients/${encodeURIComponent(options.clientId)}`;
  const realm = await request(''), client = await request(path);
  if (client.clientId !== 'trsd' || client.publicClient !== true || client.enabled !== true
    || client.attributes?.['treeseed.managed-by'] !== 'treeseed-deployment') throw new Error('CLI session policy requires the managed trsd client');
  const seconds = (value: unknown, fallback: number) => {
    if (value === undefined || value === 0) return fallback;
    if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error('Invalid Identity session lifetime');
    return Number(value);
  };
  const priorIdle = seconds(realm.ssoSessionIdleTimeout, 1800), priorMax = seconds(realm.ssoSessionMaxLifespan, 36000);
  const desiredRealm = {
    ssoSessionIdleTimeout: Math.max(CLI_SESSION_SECONDS, priorIdle),
    ssoSessionMaxLifespan: Math.max(CLI_SESSION_SECONDS, priorMax),
    clientSessionIdleTimeout: seconds(realm.clientSessionIdleTimeout, priorIdle),
    clientSessionMaxLifespan: seconds(realm.clientSessionMaxLifespan, priorMax),
  };
  const desiredAttributes = { 'client.session.idle.timeout': String(CLI_SESSION_SECONDS), 'client.session.max.lifespan': String(CLI_SESSION_SECONDS), 'access.token.lifespan': '300' };
  const matches = (actual: Record<string, unknown>, desired: Record<string, unknown>) => Object.entries(desired).every(([key, value]) => actual[key] === value);
  let action: 'noop' | 'updated' = 'noop';
  if (!matches(realm, desiredRealm)) {
    await request('', 'PUT', desiredRealm); action = 'updated';
    if (!matches(await request(''), desiredRealm)) throw new Error('CLI parent session policy read-back differs');
  }
  if (!matches(client.attributes, desiredAttributes)) {
    // PUT a partial client representation; never change scopes, keys or redirects.
    await request(path, 'PUT', { attributes: { ...client.attributes, ...desiredAttributes } }); action = 'updated';
  }
  const actual = await request(path);
  if (actual.clientId !== 'trsd' || !matches(actual.attributes ?? {}, desiredAttributes)) throw new Error('CLI client session policy read-back differs');
  return { action, sessionIdleSeconds: CLI_SESSION_SECONDS, sessionMaxSeconds: CLI_SESSION_SECONDS, accessTokenSeconds: 300 };
}

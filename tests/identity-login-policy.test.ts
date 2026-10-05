import { expect, it, vi } from 'vitest';
import { reconcileIdentityLoginPolicy, identityLoginPolicySchema } from '../src/identity/login-policy.js';

const policy = { registrationAllowed: true, resetPasswordAllowed: true, mailTransport: 'local-mailpit' as const };
it('updates fixed fields, preserves unrelated realm state, and repeats as noop', async () => {
  let realm: Record<string, unknown> = { enabled: true, unrelated: 'preserved' };
  const transport = vi.fn(async (_url, init) => {
    expect(init.redirect).toBe('error');
    if (init.method === 'PUT') { const changes = JSON.parse(init.body); expect(changes).not.toHaveProperty('enabled'); realm = { ...realm, ...changes }; return new Response(null, { status: 204 }); }
    return Response.json(realm);
  }) as typeof fetch;
  const input = { policy, resource: 'https://identity.example/admin/realms/treeseed', token: 'synthetic', transport };
  expect(await reconcileIdentityLoginPolicy(input)).toEqual({ action: 'updated' });
  expect(realm).toMatchObject({ loginTheme: 'treeseed', registrationAllowed: true, verifyEmail: true, smtpServer: { host: 'mailpit' } });
  expect(await reconcileIdentityLoginPolicy(input)).toEqual({ action: 'noop' });
});
it('requires production mail transport before enabling links and rejects policy typos', async () => {
  expect(identityLoginPolicySchema.safeParse({ ...policy, admin: true }).success).toBe(false);
  const transport = vi.fn().mockResolvedValue(Response.json({ smtpServer: { host: 'smtp.example', from: 'identity@example' } }));
  await expect(reconcileIdentityLoginPolicy({ resource: 'https://identity.example/admin/realms/treeseed', token: 'synthetic', transport,
    policy: { ...policy, mailTransport: 'existing' } })).rejects.toThrow('TLS email transport');
  expect(transport).toHaveBeenCalledTimes(1);
});
it('does not accept ignored writes or redirects as policy activation', async () => {
  for (const response of [() => Response.json({}), () => new Response(null, { status: 302 })]) {
    const transport = vi.fn().mockImplementation(response);
    await expect(reconcileIdentityLoginPolicy({ resource: 'https://identity.example/admin/realms/treeseed', token: 'synthetic', transport, policy })).rejects.toThrow();
  }
});

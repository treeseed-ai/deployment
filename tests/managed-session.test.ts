import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { withManagedOpenBao } from '../src/security/custody/index.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const scope = { team: 'team', project: 'project', environment: 'staging', purpose: 'hosting', name: 'connection' };
function setup(auth: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'treeseed-session-')); roots.push(root);
  const identityFile = join(root, 'identity.json');
  writeFileSync(identityFile, JSON.stringify({ roleId: 'synthetic-role', secretId: 'synthetic-secret' }), { mode: 0o600 });
  const fetchImpl = vi.fn(async (url: any) => String(url).endsWith('/login')
    ? Response.json({ auth }) : new Response(null, { status: 204 }));
  return { configuration: { address: 'https://openbao', mount: 'treeseed', identityFile }, fetchImpl };
}
it('revokes bounded workload sessions when the operation fails', async () => {
  const { configuration, fetchImpl } = setup({ client_token: 'test-token', policies: ['api'], lease_duration: 300 });
  await expect(withManagedOpenBao(configuration, [scope], async () => { throw new Error('operation failed'); }, fetchImpl)).rejects.toThrow('operation failed');
  expect(fetchImpl.mock.calls.map(call => call[0])).toEqual(['https://openbao/v1/auth/approle/login', 'https://openbao/v1/auth/token/revoke-self']);
});
it.each([undefined, 0, 301, '300'])('rejects invalid token lifetime %s and revokes the issued token', async duration => {
  const { configuration, fetchImpl } = setup({ client_token: 'test-token', policies: ['api'], lease_duration: duration });
  const operation = vi.fn();
  await expect(withManagedOpenBao(configuration, [scope], operation, fetchImpl)).rejects.toThrow('workload_authentication_failed');
  expect(operation).not.toHaveBeenCalled(); expect(fetchImpl).toHaveBeenCalledTimes(2);
});
it('rejects root policy and writable shared identity files', async () => {
  const { configuration, fetchImpl } = setup({ client_token: 'test-token', policies: ['root'], lease_duration: 300 });
  await expect(withManagedOpenBao(configuration, [scope], vi.fn(), fetchImpl)).rejects.toThrow('workload_authentication_failed');
  fetchImpl.mockClear(); chmodSync(configuration.identityFile, 0o660);
  await expect(withManagedOpenBao(configuration, [scope], vi.fn(), fetchImpl)).rejects.toThrow('workload_identity_unavailable');
  expect(fetchImpl).not.toHaveBeenCalled();
});
it('bounds login response size without invoking consumers', async () => {
  const { configuration } = setup({}); const operation = vi.fn();
  const fetchImpl = vi.fn(async () => new Response('x'.repeat(65_537)));
  await expect(withManagedOpenBao(configuration, [scope], operation, fetchImpl)).rejects.toThrow('workload_authentication_failed');
  expect(operation).not.toHaveBeenCalled();
});

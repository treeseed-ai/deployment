import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManagedIdentityApplications } from '../src/identity/managed-applications.js';

const mocks = vi.hoisted(() => ({ record: {} as Record<string, string>, read: vi.fn(), keys: vi.fn(), credentials: vi.fn(), ensure: vi.fn() }));
vi.mock('../src/security/custody/os.js', () => ({ OsSecretCustody: class { run(callback: (store: unknown) => unknown) { return callback({ read: mocks.read }); } } }));
vi.mock('@treeseed/identity', () => ({ discoverSigningKeys: mocks.keys, createWorkloadCredentials: mocks.credentials,
  createKeycloakApplicationRegistry: () => ({ ensure: mocks.ensure }) }));
const root = mkdtempSync(join(tmpdir(), 'treeseed-managed-identity-'));
mkdirSync(join(root, 'identity-os')); writeFileSync(join(root, 'identity-os/custody.cred'), 'synthetic-test-marker');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=reconciler-test',
  '-keyout', join(root, 'key'), '-out', join(root, 'cert')], { stdio: 'ignore' });
afterAll(() => rmSync(root, { recursive: true }));
const application = { clientId: 'admin', kind: 'browser' as const, resource: 'https://api.example', scopes: [], certificate: 'public', redirectUris: ['https://admin.example/callback'] };
const options = { stateRoot: root, publicUrl: 'https://identity.example', environment: 'staging' as const, transport: vi.fn() as typeof fetch };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.record = { publicUrl: options.publicUrl, reconcilerKey: readFileSync(join(root, 'key'), 'utf8'), reconcilerCertificate: readFileSync(join(root, 'cert'), 'utf8') };
  mocks.read.mockImplementation(scope => scope.environment === 'staging' ? { values: mocks.record } : null);
  mocks.keys.mockResolvedValue({}); mocks.credentials.mockResolvedValue({ credentials: async () => ({ accessToken: 'private-test-token' }) });
  mocks.ensure.mockResolvedValue({ action: 'noop', clientId: 'admin', id: 'client-id' });
});

it('uses an unexportable scoped asymmetric reconciler and exposes no credential in the result', async () => {
  const result = await createManagedIdentityApplications(options).ensure(application);
  expect(result).toEqual({ action: 'noop', clientId: 'admin', id: 'client-id', subject: null });
  const input = mocks.credentials.mock.calls[0]![0];
  expect(input.clientId).toBe('treeseed-identity-reconciler');
  expect(input.resources).toEqual(['https://identity.example/admin/realms/treeseed']);
  expect(input.privateKey.extractable).toBe(false);
  expect(mocks.read).toHaveBeenCalledWith({ team: 'host', project: 'identity', environment: 'staging', purpose: 'bootstrap', name: 'reconciler' });
  expect(JSON.stringify(result)).not.toMatch(/private|token|key/i);
});

it.each(['missing', 'environment', 'origin', 'key', 'certificate'] as const)('rejects %s custody before discovery and never creates bootstrap', async defect => {
  const selected = { ...options };
  if (defect === 'missing') selected.stateRoot = join(root, 'missing');
  if (defect === 'environment') mocks.read.mockReturnValue(null);
  if (defect === 'origin') mocks.record.publicUrl = 'https://other.example';
  if (defect === 'key') mocks.record.reconcilerKey = 'secret-bad-key';
  if (defect === 'certificate') mocks.record.reconcilerCertificate = 'secret-bad-certificate';
  await expect(createManagedIdentityApplications(selected).ensure(application)).rejects.toThrow('Managed Identity application reconciliation failed');
  expect(mocks.keys).not.toHaveBeenCalled(); expect(mocks.ensure).not.toHaveBeenCalled();
});

it('redacts provider errors without treating them as success', async () => {
  mocks.ensure.mockRejectedValue(new Error('private-test-token'));
  await expect(createManagedIdentityApplications(options).ensure(application)).rejects.toThrow('Managed Identity application reconciliation failed');
});

it('returns only the authoritative workload subject and rejects redirected read-back', async () => {
  const transport = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'subject-id', enabled: true })));
  const registry = createManagedIdentityApplications({ ...options, transport });
  expect(await registry.ensure({ ...application, kind: 'workload', redirectUris: [] })).toMatchObject({ subject: 'subject-id' });
  expect(transport.mock.calls[0]![0]).toBe('https://identity.example/admin/realms/treeseed/clients/client-id/service-account-user');
  expect(transport.mock.calls[0]![1]).toMatchObject({ redirect: 'error' });
  transport.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://other.example' } }));
  await expect(registry.ensure({ ...application, kind: 'workload', redirectUris: [] })).rejects.toThrow('reconciliation failed');
});

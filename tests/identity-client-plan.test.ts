import { expect, it } from 'vitest';
import { managedIdentityClientPlan } from '../src/identity/client-plan.js';
import { apiIdentityFixture } from './identity-api-fixture.js';
import { supervisorOperationSchema } from '../src/supervisor/protocol.js';

function fixture() {
  const { configuration, descriptor } = apiIdentityFixture();
  configuration.components.api!.aliases = { 'api.api.http': 'api.example' };
  configuration.components.identity = { ...configuration.components.api!, aliases: { 'identity.identity.https': 'identity.example' }, configuration: {} };
  configuration.components.admin = { ...configuration.components.api!, aliases: {}, configuration: {
    environment: { TREESEED_SITE_URL: 'https://admin.example', TREESEED_API_BASE_URL: descriptor.resource,
      TREESEED_IDENTITY_ISSUER: descriptor.issuer, TREESEED_IDENTITY_WORKLOAD_CLIENT_ID: 'admin-bff' },
    secretEnvironment: { TREESEED_IDENTITY_WORKLOAD_PRIVATE_KEY: 'admin-workload' } } };
  configuration.secrets['admin-workload'] = { provider: 'systemd-credential', reference: '/etc/treeseed/credentials/admin-workload.cred' };
  configuration.postgres = { schemaVersion: 'treeseed.postgres-topology/v1', installationId: 'test', environment: 'production',
    servers: [], allocations: [], requirements: [] };
  return { configuration, descriptor };
}

it('plans one distinct workload consumer with only browser-bridge authority', () => {
  const { configuration } = fixture();
  expect(managedIdentityClientPlan(configuration).clients[0]).toMatchObject({ componentId: 'admin',
    workloadPrincipalId: 'admin-bff', workloadKeyReference: 'admin-workload',
    permissions: ['identity:sessions:manage'], workloadScopes: ['treeseed:identity:sessions'] });
});

it.each(['issuer', 'resource', 'disabled', 'consumer', 'ambiguous', 'key', 'cookie-origin'] as const)('rejects %s drift before enrollment', defect => {
  const { configuration, descriptor } = fixture();
  const consumer = configuration.components.admin!;
  if (defect === 'issuer') descriptor.issuer = 'https://different.example/realms/treeseed';
  if (defect === 'resource') descriptor.resource = 'https://different.example';
  if (defect === 'disabled') configuration.components.identity!.enabled = false;
  if (defect === 'consumer') consumer.enabled = false;
  if (defect === 'ambiguous') configuration.components.other = structuredClone(consumer);
  if (defect === 'key') consumer.configuration.secretEnvironment = { TREESEED_IDENTITY_WORKLOAD_PRIVATE_KEY: descriptor.applications[0]!.signingKeyReference };
  if (defect === 'cookie-origin') (consumer.configuration.environment as Record<string, string>).TREESEED_SITE_URL = 'https://other.example';
  expect(() => managedIdentityClientPlan(configuration)).toThrow();
});

it('exposes no caller-controlled key, endpoint, identity or path in the fixed operation', () => {
  expect(supervisorOperationSchema.safeParse({ operation: 'identity.clients.reconcile' }).success).toBe(true);
  for (const field of ['endpoint', 'key', 'path', 'clientId'])
    expect(supervisorOperationSchema.safeParse({ operation: 'identity.clients.reconcile', [field]: 'untrusted' }).success).toBe(false);
});

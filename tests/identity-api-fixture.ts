import { deploymentDigest } from '@treeseed/sdk/deployment';
import { component, host } from './fixtures.js';

export function apiIdentityFixture() {
  const configuration = host(), release = component('api', 'stable', 'a');
  release.runtime.services.push({ id: 'migration', composeService: 'migration', endpoints: [] });
  release.runtime.postgresRequirements = [{ id: 'api', supportedMajors: [17], extensions: [], runtimeConnectionLimit: 10 }];
  release.runtime.postgresLifecycle = [{ requirementId: 'api', credentialOwner: { uid: 65532, gid: 65532 },
    migration: { composeService: 'migration', completion: 'exit-zero', timeoutSeconds: 120 }, runtimeServices: ['service'] }];
  release.runtimeDigest = deploymentDigest(release.runtime);
  const descriptor = { schemaVersion: 'treeseed.identity-api-runtime/v1' as const,
    issuer: 'https://identity.example/realms/treeseed', resource: 'https://api.example', scopes: ['profile'],
    sessionKeys: { id: 'api-session', active: { version: 1, credentialReference: 'acceptance-api-session' }, historical: [] },
    applications: [{ clientId: 'admin', workloadPrincipalId: 'admin-bff', redirectUri: 'https://admin.example/callback', scopes: ['profile'], signingKeyReference: 'acceptance-admin-signing' }] };
  configuration.components.api!.configuration.identityRuntime = descriptor;
  for (const id of ['acceptance-api-session', 'acceptance-admin-signing']) configuration.secrets[id] = {
    provider: 'systemd-credential', reference: `/etc/treeseed/credentials/${id}.cred` };
  return { configuration, release, descriptor };
}

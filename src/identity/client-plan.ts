import { identityApiRuntimeSchema, BROWSER_SESSION_PERMISSION, BROWSER_SESSION_SCOPE } from '@treeseed/sdk/identity';
import type { HostConfiguration } from '@treeseed/sdk/deployment';
import { componentCredential } from '../core/component-credential.js';

/** Public descriptors only. Deployment configuration binds each browser to
 * exactly one enabled workload consumer and an independent sealed key.
 */
export function managedIdentityClientPlan(host: HostConfiguration) {
  const config = identityApiRuntimeSchema.parse(host.components.api?.configuration.identityRuntime);
  const identity = host.components.identity;
  if (!host.components.api?.enabled || !identity?.enabled || !host.postgres) throw new Error('Managed Identity and API must be enabled');
  const origin = `https://${identity.aliases['identity.identity.https'] ?? 'identity.treeseed.localhost'}`;
  const resource = `https://${host.components.api.aliases['api.api.http'] ?? 'api.treeseed.localhost'}`;
  if (config.issuer !== `${origin}/realms/treeseed` || config.resource !== resource)
    throw new Error('Identity client registration must match managed endpoint authorities');
  const clients = config.applications.map(application => {
    const consumers = Object.entries(host.components).filter(([, item]) => item.enabled
      && (item.configuration.environment as Record<string, unknown> | undefined)?.TREESEED_IDENTITY_WORKLOAD_CLIENT_ID === application.workloadPrincipalId);
    if (consumers.length !== 1) throw new Error('Identity browser requires exactly one configured workload consumer');
    const [componentId, consumer] = consumers[0]!;
    const key = (consumer.configuration.secretEnvironment as Record<string, unknown> | undefined)?.TREESEED_IDENTITY_WORKLOAD_PRIVATE_KEY;
    if (typeof key !== 'string' || key === application.signingKeyReference
      || key === config.sessionKeys.active.credentialReference || config.sessionKeys.historical.some(value => value.credentialReference === key)
      || config.applications.some(value => value.signingKeyReference === key)
      || componentCredential(host, key).provider !== 'systemd-credential') throw new Error('Independent OS-sealed workload key required');
    if (componentCredential(host, application.signingKeyReference).provider !== 'systemd-credential') throw new Error('OS-sealed browser key required');
    const environment = consumer.configuration.environment as Record<string, unknown>;
    const apiConnection = consumer.connections.api;
    const consumerResource = environment.TREESEED_API_BASE_URL ?? (apiConnection?.kind === 'local'
      && apiConnection.componentId === 'api' && apiConnection.serviceId === 'api' && apiConnection.endpointId === 'http' ? resource : undefined);
    if (environment.TREESEED_SITE_URL !== new URL(application.redirectUri).origin
      || environment.TREESEED_IDENTITY_ISSUER !== config.issuer || consumerResource !== config.resource)
      throw new Error('Application and API Identity configuration disagree');
    return { ...application, componentId, workloadKeyReference: key,
      permissions: [BROWSER_SESSION_PERMISSION], workloadScopes: [BROWSER_SESSION_SCOPE] };
  });
  if (new Set(clients.map(item => item.workloadKeyReference)).size !== clients.length) throw new Error('Workload keys must be independent');
  return { origin, issuer: config.issuer, resource, environment: host.postgres.environment, clients };
}

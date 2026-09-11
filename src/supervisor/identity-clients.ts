import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadHostConfiguration } from '../core/configuration.js';
import { paths } from '../core/paths.js';
import { componentStateRoot } from './component.js';
import { ensureComponentCredential } from './component-sealed-write.js';
import { managedIdentityClientPlan } from '../identity/client-plan.js';
import { createManagedIdentityApplications } from '../identity/managed-applications.js';
import { ensureApplicationCertificate } from '../identity/application-certificate.js';
import { createIdentityTransport } from '../identity/transport.js';

/** Fixed operator action: only already-declared host application clients. No
 * arbitrary endpoint, admin request, filesystem target or caller-supplied key.
 * Principal records are returned for API-owned explicit mapping, not adopted
 * from untrusted bearer-token claims during ordinary authentication.
 */
export async function reconcileManagedIdentityClients() {
  const host = loadHostConfiguration(), plan = managedIdentityClientPlan(host);
  const stateRoot = componentStateRoot(host, 'identity');
  const registry = createManagedIdentityApplications({ stateRoot, publicUrl: plan.origin, environment: plan.environment,
    ...(plan.loginPolicy ? { loginPolicy: plan.loginPolicy } : {}),
    transport: createIdentityTransport({ origin: plan.origin, ca: readFileSync(`${paths.tls}/ca.crt`, 'utf8'), hostname: '127.0.0.1', port: 443 }) });
  const results = [];
  const native = await registry.ensure(plan.nativeClient);
  if (!('sessionPolicy' in native)) throw new Error('Managed CLI session policy was not verified');
  for (const client of plan.clients) {
    const certificate = (id: string, reference: string) => {
      const privateKey = ensureComponentCredential(host, reference,
        () => generateKeyPairSync('rsa', { modulusLength: 3072 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
      return ensureApplicationCertificate({ stateRoot, environment: plan.environment, clientId: id, privateKey });
    };
    await registry.ensure({ kind: 'browser', clientId: client.clientId, resource: plan.resource, scopes: client.scopes,
      profileClaims: true,
      redirectUris: [client.redirectUri], certificate: certificate(client.clientId, client.signingKeyReference) });
    const workload = await registry.ensure({ kind: 'workload', clientId: client.workloadPrincipalId, resource: plan.resource,
      scopes: client.workloadScopes, redirectUris: [], certificate: certificate(client.workloadPrincipalId, client.workloadKeyReference) });
    if (!workload.subject) throw new Error('Identity workload subject read-back failed');
    results.push({ id: client.workloadPrincipalId, issuer: plan.issuer, subject: workload.subject,
      clientId: client.workloadPrincipalId, displayName: `${client.componentId} browser session bridge`,
      permissions: client.permissions, scopes: client.workloadScopes, action: workload.action });
  }
  return { configured: true, cliSession: native.sessionPolicy, workloads: results };
}

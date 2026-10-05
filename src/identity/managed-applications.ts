import { createPrivateKey, X509Certificate, webcrypto } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createKeycloakApplicationRegistry, createWorkloadCredentials, discoverSigningKeys, type KeycloakApplication } from '@treeseed/identity';
import { OsSecretCustody } from '../security/custody/os.js';
import { reconcileIdentityLoginPolicy, type IdentityLoginPolicy } from './login-policy.js';
import { reconcileCliSessionPolicy } from './cli-session-policy.js';

/** Deployment-only registration through the already provisioned asymmetric
 * reconciler. No human/admin password, operational vault or bootstrap creation.
 * The caller supplies Deployment-approved TLS/routing, not arbitrary API input.
 */
export function createManagedIdentityApplications(options: {
  stateRoot: string; publicUrl: string; environment: 'staging' | 'production'; transport: typeof fetch;
  loginPolicy?: IdentityLoginPolicy;
}) {
  const url = new URL(options.publicUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !['staging', 'production'].includes(options.environment)) throw new Error('Invalid managed Identity boundary');
  const issuer = `${url.origin}/realms/treeseed`, resource = `${url.origin}/admin/realms/treeseed`;
  return {
    async ensure(application: KeycloakApplication) {
      let encoded: Buffer | undefined;
      let stage = 'custody';
      try {
        const root = join(options.stateRoot, 'identity-os');
        if (!existsSync(join(root, 'custody.cred'))) throw new Error();
        const custody = new OsSecretCustody(root, false);
        const record = custody.run(store => store.read({ team: 'host', project: 'identity', environment: options.environment,
          purpose: 'bootstrap', name: 'reconciler' }));
        if (!record || record.values.publicUrl !== url.origin) throw new Error();
        const privateKey = createPrivateKey(record.values.reconcilerKey!);
        const certificate = new X509Certificate(record.values.reconcilerCertificate!);
        if (privateKey.asymmetricKeyType !== 'rsa' || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
          || Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()
          || !certificate.checkPrivateKey(privateKey)) throw new Error();
        encoded = privateKey.export({ type: 'pkcs8', format: 'der' });
        const signingKey = await webcrypto.subtle.importKey('pkcs8', encoded,
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
        stage = 'workload-authentication';
        const verificationKey = await discoverSigningKeys({ issuer, transport: options.transport });
        const credentials = await createWorkloadCredentials({ issuer, clientId: 'treeseed-identity-reconciler', privateKey: signingKey as CryptoKey,
          resources: [resource], verificationKey, profile: 'keycloak', transport: options.transport,
          resolvePrincipal: async identity => ({ principalId: identity.subject, kind: 'service', clientId: 'treeseed-identity-reconciler' }) });
        const registry = createKeycloakApplicationRegistry({ issuer, transport: options.transport,
          credentials: { token: async input => (await credentials.credentials(input)).accessToken } });
        if (options.loginPolicy) {
          stage = 'login-policy';
          if (options.loginPolicy.mailTransport === 'local-mailpit' && options.environment !== 'staging') throw new Error();
          const access = await credentials.credentials({ resource, scopes: [] });
          await reconcileIdentityLoginPolicy({ resource, transport: options.transport, token: access.accessToken, policy: options.loginPolicy });
        }
        stage = 'client-registration';
        const result = await registry.ensure(application, application.profileClaims
          ? { expectedCurrent: { ...application, profileClaims: false } } : undefined);
        if (application.kind === 'native' && application.clientId === 'trsd') {
          stage = 'cli-session-policy';
          const access = await credentials.credentials({ resource, scopes: [] });
          const sessionPolicy = await reconcileCliSessionPolicy({ resource, clientId: result.id, token: access.accessToken, transport: options.transport });
          return { ...result, subject: null, sessionPolicy };
        }
        if (application.kind !== 'workload') return { ...result, subject: null };
        stage = 'workload-subject';
        if (!/^[A-Za-z0-9-]{1,128}$/u.test(result.id)) throw new Error();
        const token = await credentials.credentials({ resource, scopes: [] });
        const response = await options.transport(`${resource}/clients/${encodeURIComponent(result.id)}/service-account-user`, {
          method: 'GET', headers: { authorization: `Bearer ${token.accessToken}`, accept: 'application/json' },
          redirect: 'error', signal: AbortSignal.timeout(10_000),
        });
        if (response.status !== 200 || response.redirected) { await response.body?.cancel(); throw new Error(); }
        const reader = response.body?.getReader(); if (!reader) throw new Error();
        const chunks: Uint8Array[] = []; let size = 0;
        try { for (;;) { const item = await reader.read(); if (item.done) break;
          size += item.value.length; if (size > 65536) throw new Error(); chunks.push(item.value); } }
        finally { await reader.cancel(); reader.releaseLock(); }
        const user = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof user.id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/u.test(user.id) || user.enabled !== true) throw new Error();
        return { ...result, subject: user.id as string };
      } catch (error) {
        const drift = error instanceof Error && /^Identity application drift in [A-Za-z]+ requires a reconciliation plan$/.test(error.message) ? `; ${error.message}` : '';
        throw new Error(`Managed Identity application reconciliation failed; verify custody and authoritative client configuration [${stage}]${drift}`);
      }
      finally { encoded?.fill(0); }
    },
  };
}

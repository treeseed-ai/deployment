import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { ComponentRelease, HostConfiguration } from '@treeseed/sdk/deployment';
import { identityApiRuntimeSchema } from '@treeseed/sdk/identity';
import { apiIdentityMaterial } from './api-material.js';
import { ensureComponentCredential } from '../supervisor/component-sealed-write.js';
import { materializeApiIdentityRuntime } from '../supervisor/identity-api-files.js';

/** Serialized component configuration, with API writers stopped. This only
 * initializes declared bootstrap keys; it grants no Identity/application roles.
 * Historic session keys must already exist: inventing one would lose sessions.
 */
export function prepareApiIdentityBootstrap(host: HostConfiguration, release: ComponentRelease,
  dependencies = { ensure: ensureComponentCredential, materialize: materializeApiIdentityRuntime }) {
  const descriptor = host.components.api?.configuration.identityRuntime;
  if (descriptor === undefined) return { configured: false as const };
  const config = identityApiRuntimeSchema.parse(descriptor);
  // Validate all references and release ownership before any credential writes.
  const validation = apiIdentityMaterial(host, release, () => Buffer.alloc(32, 1));
  validation.clear();
  const active = config.sessionKeys.active.credentialReference;
  dependencies.ensure(host, active, () => randomBytes(32).toString('base64url'));
  for (const previous of config.sessionKeys.historical) dependencies.ensure(host, previous.credentialReference,
    () => { throw new Error('Historical Identity session key requires recovery'); });
  for (const application of config.applications) dependencies.ensure(host, application.signingKeyReference,
    () => generateKeyPairSync('rsa', { modulusLength: 3072 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  dependencies.materialize(host, release);
  return { configured: true as const, applications: config.applications.length };
}

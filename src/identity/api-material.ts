import { componentReleaseSchema, deploymentDigest, hostConfigurationSchema, type ComponentRelease, type HostConfiguration } from '@treeseed/sdk/deployment';
import { identityApiRuntimeSchema } from '@treeseed/sdk/identity';
import { componentCredential } from '../core/component-credential.js';

/** Bootstrap descriptors are not service-vault records. Only the verified API
 * release's OS identity may receive these keys; no caller chooses a file path.
 */
export function apiIdentityMaterial(input: HostConfiguration, selected: ComponentRelease, read: (id: string) => Buffer) {
  const host = hostConfigurationSchema.parse(input), component = componentReleaseSchema.parse(selected);
  const config = identityApiRuntimeSchema.safeParse(host.components.api?.configuration.identityRuntime);
  const owners = component.runtime.postgresLifecycle?.map(item => item.credentialOwner) ?? [];
  const owner = owners[0];
  if (!config.success || !host.components.api?.enabled || component.componentId !== 'api'
    || component.runtimeDigest !== deploymentDigest(component.runtime) || !owner
    || owners.some(item => item.uid !== owner.uid || item.gid !== owner.gid)) throw new Error('Verified API Identity bootstrap binding required');
  const references = [config.data.sessionKeys.active.credentialReference,
    ...config.data.sessionKeys.historical.map(item => item.credentialReference),
    ...config.data.applications.map(item => item.signingKeyReference)];
  for (const id of references) if (componentCredential(host, id).provider !== 'systemd-credential') throw new Error('API Identity requires OS-sealed bootstrap credentials');
  const descriptor = Buffer.from(JSON.stringify(config.data));
  // The shared OS credential reader bounds a single mounted record to 16 KiB.
  if (descriptor.length > 16384) throw new Error('API Identity bootstrap descriptor exceeds its mounted record limit');
  const files = new Map<string, Buffer>([['runtime.json', descriptor]]);
  try {
    for (const id of references) {
      const value = read(id);
      files.set(`credentials/${id}`, value);
      if (value.length < 24 || value.length > 16384 || value.includes(0)) throw new Error();
    }
    return { files, owner, clear: () => { for (const value of files.values()) value.fill(0); } };
  } catch {
    for (const value of files.values()) value.fill(0);
    throw new Error('API Identity bootstrap material unavailable');
  }
}

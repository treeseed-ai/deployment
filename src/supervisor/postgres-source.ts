import { deploymentDigest } from '@treeseed/sdk/deployment';
import { installedComponentRelease } from './component-release.js';
import { componentComposeArguments } from './compose-runtime.js';
import { postgresDocker } from './postgres-process.js';
import { inspectPostgresSource } from '../postgres/source-inventory.js';
import { withAttestedPostgresSource } from '../postgres/source-session.js';
import { fingerprintPostgresTransfer } from '../postgres/transfer-fingerprint.js';
import { z } from 'zod';

function sourceContext(componentId: string, release: string) {
  const component = installedComponentRelease(componentId, release);
  const files = component.runtime.compose.files.map(file => `${componentId}/${release}/${file.path}`);
  return { component, configuration: async () => JSON.parse(await postgresDocker(['compose',
    ...componentComposeArguments(componentId, files), '--project-name', component.runtime.compose.projectName,
    'config', '--format', 'json'], 30, true)) as unknown };
}

export async function inspectInstalledPostgresSource(componentId: string, release: string, serviceId: string) {
  try {
    const { component, configuration } = sourceContext(componentId, release);
    const configured = await configuration();
    const result = await inspectPostgresSource(component, serviceId, configured, postgresDocker);
    if (deploymentDigest(installedComponentRelease(componentId, release)) !== deploymentDigest(component)) throw new Error();
    return result;
  } catch { throw new Error('Installed PostgreSQL source inventory unavailable; source unchanged.'); }
}

/** A diagnostic fingerprint is not transfer acceptance: the transfer coordinator
 * must separately fence writers and compare again before switching bindings.
 */
export async function fingerprintInstalledPostgresSource(componentId: string, release: string,
  serviceId: string, inventoryDigest: string) {
  try {
    const { component, configuration } = sourceContext(componentId, release);
    const configured = await configuration();
    const before = await inspectPostgresSource(component, serviceId, configured, postgresDocker);
    if (before.inventoryDigest !== inventoryDigest) throw new Error();
    const services = z.object({ services: z.record(z.string(), z.unknown()) }).passthrough().parse(configured).services;
    const username = z.object({ environment: z.object({ POSTGRES_USER: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u) }) })
      .parse(services[serviceId]).environment.POSTGRES_USER;
    if (before.major !== 16 && before.major !== 17) throw new Error();
    const fingerprint = await withAttestedPostgresSource({ container: before.container, database: before.database,
      username, clusterIdentity: before.clusterIdentity, major: before.major }, postgresDocker,
    session => fingerprintPostgresTransfer(session, { database: before.database, owner: username, major: before.major as 16 | 17 }));
    if (deploymentDigest(installedComponentRelease(componentId, release)) !== deploymentDigest(component) ||
      (await inspectInstalledPostgresSource(componentId, release, serviceId)).inventoryDigest !== inventoryDigest) throw new Error();
    return { inventoryDigest, fingerprint };
  } catch { throw new Error('Installed PostgreSQL source fingerprint unavailable or changed; source unchanged.'); }
}

import { deploymentDigest } from '@treeseed/sdk/deployment';
import { installedComponentRelease } from './component-release.js';
import { componentComposeArguments } from './compose-runtime.js';
import { postgresDocker } from './postgres-process.js';
import { inspectPostgresSource } from '../postgres/source-inventory.js';

export async function inspectInstalledPostgresSource(componentId: string, release: string, serviceId: string) {
  try {
    const component = installedComponentRelease(componentId, release);
    const files = component.runtime.compose.files.map(file => `${componentId}/${release}/${file.path}`);
    const configured = JSON.parse(await postgresDocker(['compose', ...componentComposeArguments(componentId, files),
      '--project-name', component.runtime.compose.projectName, 'config', '--format', 'json'], 30, true));
    const result = await inspectPostgresSource(component, serviceId, configured, postgresDocker);
    if (deploymentDigest(installedComponentRelease(componentId, release)) !== deploymentDigest(component)) throw new Error();
    return result;
  } catch { throw new Error('Installed PostgreSQL source inventory unavailable; source unchanged.'); }
}

import type { ComponentRelease } from '@treeseed/sdk/deployment';
import { componentComposeArguments } from './compose-runtime.js';
import { postgresDocker } from './postgres-process.js';

/** Read-back only: verify exact images and actual health, never restart a
 * process while deciding whether a transfer can be accepted. */
export async function postgresComponentRuntimeHealthy(component: ComponentRelease, services: string[]) {
  const files = component.runtime.compose.files.map(file => `${component.componentId}/${component.release}/${file.path}`);
  const compose = ['compose', ...componentComposeArguments(component.componentId, files), '--project-name', component.runtime.compose.projectName];
  const configured = JSON.parse(await postgresDocker([...compose, 'config', '--format', 'json'], 30, true));
  const raw = await postgresDocker([...compose, 'ps', '--all', '--format', 'json', ...services], 30, true);
  const rows = raw.trim().startsWith('[') ? JSON.parse(raw) : raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  for (const service of services) {
    const expected = configured.services?.[service];
    const instances = rows.filter((row: { Service: string }) => row.Service === service);
    if (!expected?.image || !instances.length) return false;
    for (const instance of instances) {
      if (!/^[a-f0-9]{12,64}$/u.test(instance.ID)) return false;
      const observed = JSON.parse(await postgresDocker(['inspect', '--format', '{"image":{{json .Config.Image}},"state":{{json .State.Status}},"exit":{{json .State.ExitCode}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}}}', instance.ID], 30, true));
      if (observed.image !== expected.image || (expected.restart === 'no'
        ? observed.state !== 'exited' || observed.exit !== 0
        : observed.state !== 'running' || observed.health !== 'healthy')) return false;
    }
  }
  return true;
}

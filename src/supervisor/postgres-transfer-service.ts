import { deploymentDigest, type ComponentRelease } from '@treeseed/sdk/deployment';
import { postgresDocker } from './postgres-process.js';

/** Match retained stopped containers to the archived image inventory. Avoid
 * rendering an old manifest that package replacement may already have removed. */
export async function retainedPostgresService(component: ComponentRelease) {
  if (deploymentDigest(component.runtime) !== component.runtimeDigest) throw new Error('Source runtime changed');
  const images = component.images.filter(item => item.role === 'postgres');
  if (images.length !== 1) throw new Error('One published PostgreSQL source image required');
  const imageId = (await postgresDocker(['image', 'inspect', '--format', '{{.Id}}', `${images[0]!.repository}@${images[0]!.digest}`], 10, true)).trim();
  if (!/^sha256:[a-f0-9]{64}$/u.test(imageId)) throw new Error('Source image unavailable');
  const ids = (await postgresDocker(['ps', '--all', '--quiet', '--no-trunc', '--filter', `label=com.docker.compose.project=${component.runtime.compose.projectName}`], 10, true)).trim().split(/\s+/u).filter(Boolean);
  const matches: string[] = [];
  for (const id of ids) {
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid retained source container');
    const raw = await postgresDocker(['inspect', '--format', '{{.Image}}\t{{.State.Running}}\t{{index .Config.Labels "com.docker.compose.service"}}', id], 10, true);
    const [image, running, service] = raw.trim().split('\t');
    if (image !== imageId) continue;
    if (running !== 'false' || !service || !component.runtime.services.some(item => item.composeService === service)) throw new Error('Source is not a stopped published service');
    matches.push(service);
  }
  if (matches.length !== 1) throw new Error('One retained PostgreSQL service required');
  return matches[0]!;
}

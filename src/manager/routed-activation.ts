import { renderCaddyfile, subjectAlternativeNames, type EdgeRoute } from '../edge/caddy.js';
import { edgeReadiness } from '../edge/readiness.js';
import { requestSupervisor } from '../supervisor/client.js';

export function activateWithRoutes<T>(routes: EdgeRoute[], activate: () => Promise<T>) {
  return routedActivation({
    applyRoutes: async () => routes.length ? requestSupervisor({ operation: 'edge.apply', caddyfile: renderCaddyfile(routes), aliases: subjectAlternativeNames(routes) }) : undefined,
    activate,
    verifyRoutes: async () => !routes.length || edgeReadiness(subjectAlternativeNames(routes)),
  });
}

/** Consumers can probe public dependency URLs during startup. Route switching
 * must precede those probes, including when restoring a released generation. */
export async function routedActivation<T>(operations: {
  applyRoutes: () => Promise<unknown>;
  activate: () => Promise<T>;
  verifyRoutes: () => Promise<boolean>;
}): Promise<T> {
  await operations.applyRoutes();
  const result = await operations.activate();
  if (!await operations.verifyRoutes()) throw new Error('Managed edge TLS readiness failed after activation.');
  return result;
}

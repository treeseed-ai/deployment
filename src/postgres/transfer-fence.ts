import { z } from 'zod';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import type { SourceDocker } from './source-inventory.js';
import type { PostgresInspectionSession } from './inventory.js';

const containerId = z.string().regex(/^[a-f0-9]{64}$/u);
const networkSchema = z.object({ id: containerId, mode: z.string(), networks: z.record(z.string(), z.object({ NetworkID: containerId }).passthrough()) }).strict();

/** Container ownership/image/cluster are attested by the transfer owner first.
 * Disconnect only this exact source; never remove a shared network or another
 * container. The frozen network inventory is part of the owner's plan digest.
 */
export async function inspectPostgresSourceNetworks(container: string, docker: SourceDocker) {
  containerId.parse(container);
  const state = networkSchema.parse(JSON.parse(await docker(['inspect', '--format',
    '{"id":{{json .Id}},"mode":{{json .HostConfig.NetworkMode}},"networks":{{json .NetworkSettings.Networks}}}', container], 10, true)));
  if (state.id !== container || state.mode === 'host' || state.mode.startsWith('container:') || state.mode.startsWith('service:'))
    throw new Error('Source PostgreSQL requires an independently fenced network namespace');
  if (state.mode === 'none' && Object.keys(state.networks).some(name => name !== 'none')) throw new Error('Unexpected isolated source network');
  const networks = state.mode === 'none' ? [] : Object.values(state.networks).map(item => item.NetworkID).sort();
  if (new Set(networks).size !== networks.length) throw new Error('Ambiguous source network identity');
  return { container, networks, digest: deploymentDigest({ container, networks, mode: state.mode }) };
}

export async function fencePostgresSourceNetworks(container: string, expectedDigest: string, docker: SourceDocker) {
  const before = await inspectPostgresSourceNetworks(container, docker);
  if (before.digest !== expectedDigest) throw new Error('PostgreSQL source network inventory changed');
  for (const id of before.networks) await docker(['network', 'disconnect', id, container], 30, false);
  if ((await inspectPostgresSourceNetworks(container, docker)).networks.length) throw new Error('PostgreSQL source network remains connected');
  return { fenced: true as const, container };
}

/** After network isolation (source) or NOLOGIN fencing (destination), terminate
 * only clients belonging to the selected application roles, then reject any
 * remaining unknown client. This never terminates another database's sessions.
 */
export async function terminatePostgresTransferWriters(session: PostgresInspectionSession, database: string, roles: string[]) {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(database) || !roles.length || roles.length > 3 ||
    roles.some(role => !/^[a-z][a-z0-9_]{0,62}$/u.test(role)) || new Set(roles).size !== roles.length) throw new Error('Exact PostgreSQL writer roles required');
  try {
    const identity = await session.query('SELECT current_database()=$1 AS selected', [database]);
    if (identity.rows[0]?.selected !== true) throw new Error();
    const result = await session.query(`SELECT pg_terminate_backend(pid,5000) AS terminated FROM pg_stat_activity
      WHERE datname=$1 AND usename=ANY($2::text[]) AND backend_type='client backend' AND pid<>pg_backend_pid()`, [database, roles]);
    if (result.rows.some(row => row.terminated !== true)) throw new Error();
    const remaining = await session.query(`SELECT NOT EXISTS (SELECT 1 FROM pg_stat_activity
      WHERE datname=$1 AND backend_type='client backend' AND pid<>pg_backend_pid()) AS idle`, [database]);
    if (remaining.rows[0]?.idle !== true) throw new Error();
    return { fenced: true as const };
  } catch { throw new Error('PostgreSQL writer containment is unverified; retain the recovery hold'); }
}

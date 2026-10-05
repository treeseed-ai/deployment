import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { LocalSecretCustody } from '../security/custody/local.js';
import { postgresTransferJournalRoot } from '../core/postgres-transfer-hold.js';
import { postgresDocker } from './postgres-process.js';
import type { SourceDocker } from '../postgres/source-inventory.js';

const helper = z.object({
  name: z.string().regex(/^\/treeseed-postgres-copy-[a-f0-9-]{36}$/u),
  owner: z.literal('postgres-source-copy'), network: z.literal('none'), readonly: z.literal(true),
  mounts: z.array(z.object({ Type: z.string(), Source: z.string(), Destination: z.string() }).passthrough()),
}).strict();
const format = '{"name":{{json .Name}},"owner":{{json (index .Config.Labels "org.treeseed.manager")}},"network":{{json .HostConfig.NetworkMode}},"readonly":{{json .HostConfig.ReadonlyRootfs}},"mounts":{{json .Mounts}}}';

/** Internal recovery under the transfer OS lock, including process death before
 * an intent exists. Remove only verified, networkless COPIES. Original sources,
 * journal history and encrypted recovery archives are never deletion targets.
 * Ports are test/internal only, not accepted on the supervisor wire. */
export async function cleanupPostgresSourceCopies(root = `${postgresTransferJournalRoot}/sources`, docker: SourceDocker = postgresDocker) {
  if (!existsSync(root)) return { removed: 0 };
  new LocalSecretCustody(root);
  const directories = readdirSync(root).map(name => {
    if (!/^postgres-source-[A-Za-z0-9]{6}$/u.test(name)) throw new Error('Unexpected PostgreSQL source staging entry');
    const path = join(root, name), stat = lstatSync(path);
    if (realpathSync(path) !== path || !stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077))
      throw new Error('Unsafe PostgreSQL source staging custody');
    return path;
  });
  const ids = (await docker(['ps', '--all', '--quiet', '--no-trunc', '--filter', 'label=org.treeseed.manager=postgres-source-copy'], 10, true)).trim().split(/\s+/u).filter(Boolean);
  for (const id of ids) {
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid PostgreSQL helper inventory');
    const value = helper.parse(JSON.parse(await docker(['inspect', '--format', format, id], 10, true)));
    const binds = value.mounts.filter(mount => mount.Type === 'bind');
    const data = binds.filter(mount => mount.Destination === '/var/lib/postgresql/data');
    const config = binds.filter(mount => mount.Destination === '/run/treeseed-source');
    if (binds.length !== 2 || data.length !== 1 || config.length !== 1 ||
      !directories.some(path => data[0]!.Source.startsWith(`${path}/`) && config[0]!.Source === join(path, 'helper-config')))
      throw new Error('PostgreSQL helper is outside private copy custody');
    await docker(['rm', '--force', id], 30, false);
  }
  // Any other container referencing a copy, including a stopped or read-only
  // mount, is unexpected ownership: preserve the copy and require inspection.
  const remaining = (await docker(['ps', '--all', '--quiet', '--no-trunc'], 10, true)).trim().split(/\s+/u).filter(Boolean);
  for (const id of remaining) {
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid PostgreSQL cleanup inventory');
    const mounts = z.array(z.object({ Source: z.string() }).passthrough()).parse(JSON.parse(await docker(['inspect', '--format', '{{json .Mounts}}', id], 10, true)));
    if (mounts.some(mount => mount.Source.startsWith('/') && directories.some(path => mount.Source === '/' || mount.Source === path || mount.Source.startsWith(`${path}/`) || path.startsWith(`${mount.Source}/`))))
      throw new Error('PostgreSQL source copy remains mounted');
  }
  for (const path of directories) rmSync(path, { recursive: true });
  return { removed: directories.length };
}

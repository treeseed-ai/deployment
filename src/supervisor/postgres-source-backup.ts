import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { componentReleaseSchema, deploymentDigest, hostConfigurationSchema } from '@treeseed/sdk/deployment';
import { z } from 'zod';
import { loadHostConfiguration } from '../core/configuration.js';
import { inspectPostgresSource } from '../postgres/source-inventory.js';
import { withAttestedPostgresSource } from '../postgres/source-session.js';
import { fingerprintPostgresTransfer } from '../postgres/transfer-fingerprint.js';
import { inspectGenerationBackup } from './backup.js';
import { componentStateRoot } from './component.js';
import { postgresDocker } from './postgres-process.js';

// Select only non-secret environment entries in Docker's formatter. Never
// request or relay the full container environment to reconstruct source custody.
export const backupPostgresSourceFormat = '{"image":{{json .Config.Image}},"mounts":{{json .Mounts}},' +
  '"database":{{range .Config.Env}}{{if eq (index (split . "=") 0) "POSTGRES_DB"}}{{json .}}{{end}}{{end}},' +
  '"username":{{range .Config.Env}}{{if eq (index (split . "=") 0) "POSTGRES_USER"}}{{json .}}{{end}}{{end}}}';

const container = z.string().regex(/^[a-f0-9]{64}$/u);
const fields = z.object({ image: z.string().min(1).max(512),
  database: z.string().regex(/^POSTGRES_DB=[a-z][a-z0-9_]{0,62}$/u),
  username: z.string().regex(/^POSTGRES_USER=[a-z][a-z0-9_]{0,62}$/u),
  mounts: z.array(z.object({ Type: z.string(), Source: z.string(), Destination: z.string() }).passthrough()).max(128),
}).strict();

/** Component package replacement can remove its old manifest files while the
 * source container/data remain. Recover that immutable authority from the exact
 * authenticated restore point, not a retired checkout or unverified Docker label.
 * Internal root adapter: no supplied SQL, source path, credentials or manifests.
 */
export async function inspectRecoveryPostgresSource(generation: number, expectedBackupDigest: string,
  componentId: string, serviceId: string) {
  return inspectBackupPostgresSource(generation,expectedBackupDigest,componentId,serviceId);
}

/** Internal transaction-scoped reader, used only while holding the transfer OS
 * lock that also excludes archive retention/recovery. Authenticate the immutable
 * backup once, but reattest the actual source on every call. Never cache across
 * supervisor requests or bypass authentication for public diagnostics.
 */
export async function createRecoveryPostgresSourceReader(generation:number,expectedBackupDigest:string,componentId:string,serviceId:string) {
  const backup=await inspectGenerationBackup(generation);
  return ()=>inspectBackupPostgresSource(generation,expectedBackupDigest,componentId,serviceId,backup);
}

async function inspectBackupPostgresSource(generation:number,expectedBackupDigest:string,componentId:string,serviceId:string,
  authenticated?:Awaited<ReturnType<typeof inspectGenerationBackup>>) {
  try {
    if (process.getuid?.() !== 0 || !/^sha256:[a-f0-9]{64}$/u.test(expectedBackupDigest) ||
      !/^[a-z][a-z0-9.-]{0,127}$/u.test(serviceId)) throw new Error();
    const backup = authenticated ?? await inspectGenerationBackup(generation);
    if (`sha256:${backup.sha256}` !== expectedBackupDigest) throw new Error();
    const previous = hostConfigurationSchema.parse(backup.configuration), current = loadHostConfiguration();
    if (previous.configurationId !== current.configurationId || previous.host.id !== current.host.id ||
      previous.runtime.environment !== current.runtime.environment || !previous.components[componentId]?.enabled) throw new Error();
    const releases = z.array(componentReleaseSchema).parse(backup.components);
    const matches = releases.filter(item => item.componentId === componentId);
    if (matches.length !== 1) throw new Error();
    const release = matches[0]!;
    if (!release.runtime.services.some(item => item.composeService === serviceId) || deploymentDigest(release.runtime) !== release.runtimeDigest) throw new Error();
    const volume = release.runtime.stateVolumes.find(item => item.id === 'postgres' && item.backup === 'required');
    const prefix = `/var/lib/treeseed/components/${componentId}/`;
    if (!volume?.volume.startsWith(prefix)) throw new Error();
    const suffix = volume.volume.slice(prefix.length);
    if (!suffix || suffix.split('/').some(part => part === '..' || part === '.' || !part)) throw new Error();
    const sourcePath = resolve(componentStateRoot(previous,componentId),suffix);
    if (!backup.coverage.stateDirectories.includes(sourcePath.slice(1)) || realpathSync(sourcePath) !== sourcePath) throw new Error();
    const ids = (await postgresDocker(['ps','--all','--quiet','--no-trunc','--filter',
      `label=com.docker.compose.project=${release.runtime.compose.projectName}`,'--filter',`label=com.docker.compose.service=${serviceId}`],10,true)).trim().split(/\s+/u);
    if (ids.length !== 1) throw new Error();
    const id = container.parse(ids[0]);
    const observed = fields.parse(JSON.parse(await postgresDocker(['inspect','--format',backupPostgresSourceFormat,id],10,true)));
    const dataMounts = observed.mounts.filter(item => item.Destination === '/var/lib/postgresql/data' || item.Destination.startsWith('/var/lib/postgresql/data/'));
    if (dataMounts.length !== 1 || dataMounts[0]?.Type !== 'bind' || dataMounts[0]?.Source !== sourcePath || dataMounts[0]?.Destination !== '/var/lib/postgresql/data') throw new Error();
    const username = observed.username.slice('POSTGRES_USER='.length), database = observed.database.slice('POSTGRES_DB='.length);
    const source = await inspectPostgresSource(release,serviceId,{ services: { [serviceId]: { image: observed.image,
      environment: { POSTGRES_DB: database, POSTGRES_USER: username } } } },postgresDocker);
    if (source.container !== id) throw new Error();
    const dataDirectory = (await postgresDocker(['exec',id,'env','-i','PATH=/usr/local/bin:/usr/bin:/bin','PGPASSFILE=/dev/null',
      'psql','-XqAt','--no-password','-h','/var/run/postgresql','-U',username,'-d',database,
      '-v','ON_ERROR_STOP=1','-c','SHOW data_directory'],10,true)).trim();
    if (dataDirectory !== '/var/lib/postgresql/data') throw new Error();
    return { source, username, backupGeneration: generation, backupDigest: expectedBackupDigest,
      storageDigest: deploymentDigest({ sourcePath, dataDirectory }), configurationDigest: deploymentDigest(previous),
      coveredState: backup.coverage.stateDirectories };
  } catch { throw new Error('Recovery-bound PostgreSQL source custody is unavailable or changed; source unchanged'); }
}

/** Diagnostic only: rows and source login names stay inside root custody. The
 * caller freezes the exact source descriptor; transfer still requires fencing.
 */
export async function inspectRecoveryPostgresFingerprint(generation: number, backupDigest: string,
  componentId: string, serviceId: string, inventoryDigest?: string) {
  const before = await inspectRecoveryPostgresSource(generation, backupDigest, componentId, serviceId);
  const descriptor = { ...before.source, backupGeneration: generation, backupDigest,
    storageDigest: before.storageDigest, configurationDigest: before.configurationDigest };
  const custodyDigest = deploymentDigest(descriptor);
  if (inventoryDigest === undefined) return { descriptor, custodyDigest };
  if (inventoryDigest !== custodyDigest) throw new Error('Exact recovery-bound PostgreSQL source required');
  const { source, username } = before;
  if (source.major !== 16 && source.major !== 17) throw new Error('Unsupported source PostgreSQL major');
  const major = source.major;
  const fingerprint = await withAttestedPostgresSource({ container: source.container, database: source.database,
    username, clusterIdentity: source.clusterIdentity, major }, postgresDocker,
  session => fingerprintPostgresTransfer(session, { database: source.database, owner: username, major }));
  const after = await inspectRecoveryPostgresSource(generation, backupDigest, componentId, serviceId);
  if (deploymentDigest(after) !== deploymentDigest(before)) throw new Error('Recovery-bound source changed during inspection');
  return { descriptor, custodyDigest, fingerprint };
}

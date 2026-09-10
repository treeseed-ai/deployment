import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { postgresSourceDescriptorSchema, postgresSourceInventorySql, type SourceDocker } from '../postgres/source-inventory.js';
import { backupPostgresSourceFormat } from './postgres-source-backup.js';
import type { stagePostgresBackup } from './postgres-backup-stage.js';

const id = z.string().regex(/^[a-f0-9]{64}$/u);
const observedSchema = z.object({
  image: z.string(), database: z.string().regex(/^POSTGRES_DB=[a-z][a-z0-9_]{0,62}$/u),
  username: z.string().regex(/^POSTGRES_USER=[a-z][a-z0-9_]{0,62}$/u),
  mounts: z.array(z.object({ Type: z.string(), Source: z.string(), Destination: z.string() }).passthrough()),
  running: z.literal(false), restarting: z.literal(false), imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
}).strict();
const format = backupPostgresSourceFormat.slice(0, -1) + ',"running":{{json .State.Running}},"restarting":{{json .State.Restarting}},"imageId":{{json .Image}}}';
const helperConfiguration = "listen_addresses=''\nunix_socket_directories='/run/postgresql'\nhba_file='/run/treeseed-source/pg_hba.conf'\nssl=off\nshared_preload_libraries=''\narchive_mode=off\nautovacuum=off\nlogging_collector=off\nmax_connections=10\ndefault_transaction_read_only=on\n";

/** Internal root transaction only. A temporary, networkless helper opens an
 * authenticated COPY; the old container and its PGDATA are never started or
 * changed. Retained-container metadata supplies identifiers only, never secrets.
 * Caller holds the transfer lock and owns the copy's eventual deletion. */
export async function withPostgresSourceCopy<T>(staged: Awaited<ReturnType<typeof stagePostgresBackup>>,
  serviceId: string, docker: SourceDocker, run: (source: {
    container: string; database: string; username: string; major: 16 | 17;
    clusterIdentity: string; locale: z.infer<typeof postgresSourceDescriptorSchema>['locale'];
    custodyDigest: string; imageDigest: string; revalidate: () => Promise<void>; stop: () => Promise<void>;
  }) => Promise<T>): Promise<T> {
  if (process.getuid?.() !== 0 || !staged.component.runtime.services.some(item => item.composeService === serviceId) ||
    realpathSync(staged.directory) !== staged.directory || realpathSync(staged.dataDirectory) !== staged.dataDirectory ||
    staged.dataDirectory !== join(staged.directory, staged.member)) throw new Error('Exact source copy custody required');
  const root = lstatSync(staged.directory), data = lstatSync(staged.dataDirectory);
  if (root.uid !== 0 || (root.mode & 0o077) || !root.isDirectory() || !data.isDirectory() || data.uid === 0 || (data.mode & 0o077))
    throw new Error('Unsafe PostgreSQL source copy ownership');
  const original = id.parse((await docker(['ps', '--all', '--quiet', '--no-trunc', '--filter',
    `label=com.docker.compose.project=${staged.component.runtime.compose.projectName}`, '--filter',
    `label=com.docker.compose.service=${serviceId}`], 10, true)).trim());
  const inspectOriginal = async () => {
    const value = observedSchema.parse(JSON.parse(await docker(['inspect', '--format', format, original], 10, true)));
    const mounts = value.mounts.filter(item => item.Destination === '/var/lib/postgresql/data' || item.Destination.startsWith('/var/lib/postgresql/data/'));
    if (mounts.length !== 1 || mounts[0]!.Type !== 'bind' || mounts[0]!.Source !== `/${staged.member}` ||
      mounts[0]!.Destination !== '/var/lib/postgresql/data') throw new Error('Retained PostgreSQL source mount changed');
    return value;
  };
  const observed = await inspectOriginal();
  const repository = observed.image.split('@')[0]!.replace(/:[^/:]+$/u, '');
  const image = staged.component.images.filter(item => item.repository === repository);
  if (image.length !== 1) throw new Error('Exact archived PostgreSQL image required');
  const pinnedImage = `${image[0]!.repository}@${image[0]!.digest}`;
  if ((await docker(['image', 'inspect', '--format', '{{.Id}}', pinnedImage], 10, true)).trim() !== observed.imageId)
    throw new Error('Retained PostgreSQL image changed');
  // Cold snapshots must not require external WAL or upstream replication.
  for (const file of ['standby.signal', 'recovery.signal', 'backup_label'])
    if (existsSync(join(staged.dataDirectory, file))) throw new Error('Source copy requires unsupported recovery');
  // Discard source-side startup commands/settings only in this disposable COPY.
  writeFileSync(join(staged.dataDirectory, 'postgresql.auto.conf'), '', { mode: 0o600 });
  rmSync(join(staged.dataDirectory, 'postmaster.pid'), { force: true });
  const config = join(staged.directory, 'helper-config'); mkdirSync(config, { mode: 0o755 }); chmodSync(config, 0o755);
  for (const [name, content] of [['postgresql.conf', helperConfiguration], ['pg_hba.conf', 'local all all trust\n']] as const) {
    const path = join(config, name); writeFileSync(path, content, { flag: 'wx', mode: 0o444 }); chmodSync(path, 0o444);
  }
  const name = `treeseed-postgres-copy-${randomUUID()}`;
  let container: string | undefined;
  let removed = false;
  let stage = 'helper-start';
  try {
    container = id.parse((await docker(['run', '--detach', '--name', name, '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '128', '--memory', '2g',
      '--user', `${data.uid}:${data.gid}`, '--label', 'org.treeseed.manager=postgres-source-copy',
      '--mount', `type=bind,source=${staged.dataDirectory},target=/var/lib/postgresql/data`,
      '--mount', `type=bind,source=${config},target=/run/treeseed-source,readonly`,
      '--tmpfs', `/run/postgresql:rw,noexec,nosuid,nodev,size=16m,mode=0770,uid=${data.uid},gid=${data.gid}`,
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777', '--entrypoint', 'postgres', pinnedImage,
      '-D', '/var/lib/postgresql/data', '-c', 'config_file=/run/treeseed-source/postgresql.conf'], 30, true)).trim());
    const database = observed.database.slice(12), username = observed.username.slice(14);
    stage = 'helper-attestation';
    const query = async () => postgresSourceDescriptorSchema.parse(JSON.parse(await docker(['exec', container!, 'env', '-i',
      'PATH=/usr/local/bin:/usr/bin:/bin', 'PGPASSFILE=/dev/null', 'psql', '--no-password', '-XqAt', '-h', '/run/postgresql',
      '-U', username, '-d', database, '-v', 'ON_ERROR_STOP=1', '-c', postgresSourceInventorySql], 15, true)));
    let inventory: z.infer<typeof postgresSourceDescriptorSchema> | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { inventory = await query(); break; } catch { if (attempt === 29) throw new Error('Source copy startup failed'); await delay(500); }
    }
    if (!inventory || inventory.major !== staged.major || inventory.database !== database) throw new Error('Source copy database changed');
    const before = inventory;
    const revalidate = async () => {
      if (deploymentDigest(await inspectOriginal()) !== deploymentDigest(observed) || deploymentDigest(await query()) !== deploymentDigest(before))
        throw new Error('PostgreSQL source copy identity changed');
    };
    await revalidate();
    stage = 'transfer-operation';
    const stop = async () => { if (!removed) { await docker(['rm', '--force', container!], 30, false); removed = true; } };
    const value = await run({ container, database, username, major: staged.major, locale: before.locale, imageDigest: image[0]!.digest, stop,
      clusterIdentity: deploymentDigest({ cluster: before.cluster }),
      custodyDigest: deploymentDigest({ backup: staged.backupDigest, member: staged.member, runtime: staged.component.runtimeDigest,
        image: pinnedImage, original, inventory: before }), revalidate });
    if (!removed) await revalidate();
    else if (deploymentDigest(await inspectOriginal()) !== deploymentDigest(observed)) throw new Error('Original source changed');
    return value;
  } catch (error) {
    // Preserve bounded code locations and phase, never driver messages, SQL,
    // process output or credential values. Useful in privileged Actions too.
    const locations = error instanceof Error ? [...(error.stack ?? '').matchAll(/\/(src\/[a-zA-Z0-9_./-]+\.[jt]s:\d+:\d+)/gu)].slice(0, 6).map(match => match[1]) : [];
    const phase = error instanceof Error ? /PostgreSQL transfer failed \(([a-z-]+)\)/u.exec(error.message)?.[1] : undefined;
    const causeStage = z.object({ stage: z.enum(['selection', 'container-selection', 'container-image', 'data-mount', 'socket-mount', 'allocation-custody', 'cluster-readback']) }).safeParse(error && typeof error === 'object' && 'diagnostic' in error ? error.diagnostic : undefined);
    throw Object.assign(new Error('Isolated PostgreSQL source copy failed; retain coordinated recovery'), { diagnostic: { stage, phase, locations, causeStage: causeStage.success ? causeStage.data.stage : undefined } });
  }
  finally {
    // A failed Docker command can still have created the exact random-name
    // helper. Remove only that helper; never prune or touch the original.
    if (!removed) await docker(['rm', '--force', container ?? name], 30, false);
  }
}

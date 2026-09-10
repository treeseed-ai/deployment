import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { z } from 'zod';
import { componentReleaseSchema, deploymentDigest, hostConfigurationSchema } from '@treeseed/sdk/deployment';
import { LocalSecretCustody } from '../security/custody/local.js';
import { componentStateRoot } from './component.js';
import { decryptBackupStream } from './backup-stream.js';
import { withVerifiedGenerationBackup } from './backup.js';
import type { BackupEntry } from './backup-coverage.js';

/** Internal selection from authenticated archive metadata, never a caller path.
 * Tablespaces and external/symbolic links require another explicit migration
 * contract; do not silently copy data from outside this database's allocation. */
export function selectPostgresBackupState(inspection: {
  configuration: unknown; components: unknown; coverage: { stateDirectories: string[] }; entries: BackupEntry[];
}, componentId: string) {
  if (!/^[a-z][a-z0-9.-]{0,127}$/u.test(componentId)) throw new Error('Invalid PostgreSQL source component');
  const configuration = hostConfigurationSchema.parse(inspection.configuration);
  const matches = z.array(componentReleaseSchema).parse(inspection.components).filter(item => item.componentId === componentId);
  if (matches.length !== 1 || !configuration.components[componentId]?.enabled) throw new Error('Enabled backup source custody required');
  const component = matches[0]!;
  if (deploymentDigest(component.runtime) !== component.runtimeDigest) throw new Error('Source runtime digest changed');
  const volumes = component.runtime.stateVolumes.filter(item => item.id === 'postgres' && item.backup === 'required');
  const prefix = `/var/lib/treeseed/components/${componentId}/`;
  if (volumes.length !== 1 || !volumes[0]!.volume.startsWith(prefix)) throw new Error('One covered PostgreSQL source volume required');
  const suffix = volumes[0]!.volume.slice(prefix.length);
  if (!suffix || posix.normalize(suffix) !== suffix || suffix.split('/').includes('..')) throw new Error('Unsafe PostgreSQL backup selection');
  const member = resolve(componentStateRoot(configuration, componentId), suffix).slice(1);
  if (!inspection.coverage.stateDirectories.includes(member)) throw new Error('PostgreSQL source is outside coordinated backup coverage');
  const entries = inspection.entries.filter(entry => entry.path.replace(/\/$/u, '') === member || entry.path.startsWith(`${member}/`));
  if (!entries.some(entry => entry.path.replace(/\/$/u, '') === member && entry.type === 'Directory') ||
    entries.some(entry => !['File', 'Directory'].includes(entry.type))) throw new Error('PostgreSQL source contains unsupported archive links or missing data');
  return { configuration, component, member };
}

/** Prepare a private COPY from the exact recovery point. Never start PostgreSQL
 * on the original retained data or restore configuration/credentials into the
 * live installation. The caller holds the transfer lock and owns helper cleanup.
 * This adapter and its test ports are not exposed on the supervisor wire. */
export async function stagePostgresBackup(generation: number, options: {
  backupRoot: string; stagingRoot: string; key: Buffer; backupDigest: string; componentId: string;
  checkOriginalStopped: (members: string[]) => void;
}) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(options.backupDigest)) throw new Error('Exact PostgreSQL recovery digest required');
  mkdirSync(options.stagingRoot, { recursive: true, mode: 0o700 });
  new LocalSecretCustody(options.stagingRoot);
  return withVerifiedGenerationBackup(generation, { backupRoot: options.backupRoot, key: options.key,
    expectedSha256: options.backupDigest.slice(7) }, async (inspection, snapshot) => {
    const selected = selectPostgresBackupState(inspection, options.componentId);
    options.checkOriginalStopped([selected.member]);
    const directory = mkdtempSync(join(options.stagingRoot, 'postgres-source-'));
    const key = Buffer.from(options.key);
    try {
      const child = spawn('/usr/bin/tar', ['--extract', '--gzip', '--file', '-', '--directory', directory,
        '--numeric-owner', '--keep-old-files', '--no-wildcards', '--', selected.member],
      { stdio: ['pipe', 'ignore', 'pipe'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } });
      child.stderr.resume();
      try {
        const [exit] = await Promise.all([once(child, 'exit'), decryptBackupStream(snapshot, generation, key, child.stdin)]);
        if (exit[0] !== 0) throw new Error('Scoped PostgreSQL snapshot extraction failed');
      } finally { child.kill(); }
      const dataDirectory = resolve(directory, selected.member);
      const version = readFileSync(join(dataDirectory, 'PG_VERSION'), 'utf8').trim();
      if (!/^(16|17)$/u.test(version)) throw new Error('Unsupported retained PostgreSQL source major');
      options.checkOriginalStopped([selected.member]);
      return { ...selected, generation, backupDigest: options.backupDigest, directory, dataDirectory, major: Number(version) as 16 | 17 };
    } catch {
      rmSync(directory, { recursive: true, force: true });
      throw new Error('PostgreSQL source snapshot staging failed; original state unchanged');
    } finally { key.fill(0); }
  });
}

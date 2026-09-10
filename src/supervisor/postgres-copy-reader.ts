import { rmSync } from 'node:fs';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { paths } from '../core/paths.js';
import { loadHostConfiguration } from '../core/configuration.js';
import { postgresTransferJournalRoot } from '../core/postgres-transfer-hold.js';
import type { ManagedPostgresTransferSelection } from '../postgres/managed-transfer-contract.js';
import { assertNoBackupWriters } from './backup-writers.js';
import { withApplicationBackupKey } from './backup.js';
import { stagePostgresBackup } from './postgres-backup-stage.js';
import { withPostgresSourceCopy } from './postgres-source-copy.js';
import { postgresDocker } from './postgres-process.js';
import type { inspectRecoveryPostgresSource } from './postgres-source-backup.js';

export type PostgresTransferSourceReader = () => Promise<Awaited<ReturnType<typeof inspectRecoveryPostgresSource>>>;

/** The root coordinator holds the OS lock for this entire scope. Never cache
 * this reader across operations or expose its login/path custody to the wire. */
export async function withManagedPostgresSourceCopy<T>(selection: ManagedPostgresTransferSelection,
  run: (source: { read: PostgresTransferSourceReader; stop: () => Promise<void> }) => Promise<T>): Promise<T> {
  const current = loadHostConfiguration();
  const staged = await withApplicationBackupKey(key => stagePostgresBackup(selection.generation, {
    backupRoot: paths.backups, stagingRoot: `${postgresTransferJournalRoot}/sources`, key,
    backupDigest: selection.backupDigest, componentId: selection.componentId, checkOriginalStopped: assertNoBackupWriters,
  }));
  let cleanup = false;
  try {
    if (staged.configuration.configurationId !== current.configurationId || staged.configuration.host.id !== current.host.id ||
      staged.configuration.runtime.environment !== current.runtime.environment) throw new Error('Source installation changed');
    const value = await withPostgresSourceCopy(staged, selection.serviceId, postgresDocker, async helper => {
      const descriptor = { componentId: selection.componentId, release: staged.component.release, serviceId: selection.serviceId,
        container: helper.container, runtimeDigest: staged.component.runtimeDigest,
        imageDigest: helper.imageDigest,
        clusterIdentity: helper.clusterIdentity, database: helper.database, major: helper.major, locale: helper.locale };
      const result = { source: { ...descriptor, inventoryDigest: deploymentDigest({ ...descriptor, custody: helper.custodyDigest }) },
        username: helper.username, backupGeneration: selection.generation, backupDigest: selection.backupDigest,
        storageDigest: deploymentDigest({ member: staged.member, backup: staged.backupDigest }),
        configurationDigest: deploymentDigest(staged.configuration), coveredState: staged.coveredState };
      return run({ stop: helper.stop, read: async () => {
        if (deploymentDigest(loadHostConfiguration()) !== deploymentDigest(current)) throw new Error('Target configuration changed');
        assertNoBackupWriters([staged.member]); await helper.revalidate();
        return structuredClone(result);
      } });
    });
    cleanup = true; return value;
  } finally {
    // If helper cleanup itself was uncertain, retain its private data for
    // explicit recovery rather than removing a potentially mounted directory.
    if (cleanup) rmSync(staged.directory, { recursive: true, force: true });
  }
}

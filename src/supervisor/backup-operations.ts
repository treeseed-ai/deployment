import { spawnSync } from 'node:child_process';
import type { SupervisorOperation } from './protocol.js';
import type { CommandRunner } from './compose-runtime.js';
import { createGenerationBackup, inspectGenerationBackup, listGenerationBackups, restoreGenerationBackup } from './backup.js';
import { beginDevelopmentBackup, finishDevelopmentBackup, developmentBackupDependencies, developmentBackupStatus, fenceDevelopmentBackup, markDevelopmentBackupRestored } from './development-backup.js';
import { postgresTransferJournal } from './postgres-transfer-guard.js';

const command: CommandRunner = (executable, args) => {
  const result = spawnSync(executable, [...args], { encoding: 'utf8', timeout: 180_000, maxBuffer: 1_048_576,
    stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } });
  if (result.error || result.status !== 0) throw new Error('Development backup lifecycle command failed; inspect hold and runner status.');
  return result.stdout;
};

export function executeBackupOperation(operation: SupervisorOperation) {
  const deps = developmentBackupDependencies(command);
  switch (operation.operation) {
    case 'development.backup.begin': return beginDevelopmentBackup(operation.generation, deps, operation.apiRuntimeDigest);
    case 'development.backup.finish': return finishDevelopmentBackup(operation.generation, deps);
    case 'development.backup.status': return developmentBackupStatus(deps);
    case 'development.backup.fence': return fenceDevelopmentBackup(operation.generation, deps, operation.apiRuntimeDigest);
    case 'backup.create': return createGenerationBackup(operation.generation);
    case 'backup.inspect': return inspectGenerationBackup(operation.generation);
    case 'backup.list': return listGenerationBackups();
    case 'recovery.restore': {
      const journal = postgresTransferJournal();
      // A recovery request must not replace state while a transfer is still
      // importing or activating. Re-read the pin after acquiring its OS lock.
      return journal.locked(async () => {
        const active = journal.active();
        if (active && active.restoreGeneration !== operation.generation) throw new Error('Exact coordinated PostgreSQL restore point required');
        const result = await restoreGenerationBackup(operation.generation, active?.restoreDigest.slice(7));
        markDevelopmentBackupRestored(deps);
        if (active) journal.restored(result.generation, result.sha256);
        return result;
      });
    }
    default: throw new Error('Unknown fixed backup operation.');
  }
}

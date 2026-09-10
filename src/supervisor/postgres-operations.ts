import type { SupervisorOperation } from './protocol.js';
import { reconcileLocalPostgres } from './postgres.js';
import { inspectInstalledPostgresSource, fingerprintInstalledPostgresSource } from './postgres-source.js';
import { activateOrTransferPostgresComponent } from './postgres-transfer-execution.js';
import { prepareLocalPostgresTransition } from './postgres-transition-custody.js';
import { inspectRecoveryPostgresFingerprint } from './postgres-source-backup.js';
import { planManagedPostgresTransfer } from './postgres-transfer-plan.js';
import { postgresTransferJournal } from './postgres-transfer-guard.js';

type PostgresOperation = Extract<SupervisorOperation, { operation: 'postgres.plan' | 'postgres.apply' | 'postgres.source.inspect' | 'postgres.source.fingerprint' | 'postgres.source.recovery.inspect' | 'postgres.transfer.plan' | 'postgres.transfer.prepare' | 'postgres.component.activate' }>;
const operations = new Set<PostgresOperation['operation']>(['postgres.plan','postgres.apply','postgres.source.inspect',
  'postgres.source.fingerprint','postgres.source.recovery.inspect','postgres.component.activate','postgres.transfer.plan','postgres.transfer.prepare']);
export function isPostgresOperation(operation: SupervisorOperation): operation is PostgresOperation {
  return [...operations].some(name => name === operation.operation);
}

export function executePostgresOperation(operation: PostgresOperation) {
  if (operation.operation === 'postgres.apply') {
    const journal=postgresTransferJournal();
    return journal.locked(async()=>{
      if(journal.active())throw new Error('PostgreSQL transfer holds allocation and runtime mutation');
      return dispatchPostgresOperation(operation);
    });
  }
  return dispatchPostgresOperation(operation);
}

function dispatchPostgresOperation(operation: PostgresOperation) {
  switch (operation.operation) {
    case 'postgres.transfer.prepare': {
      const {operation:_operation,planOnly,...selection}=operation;
      return prepareLocalPostgresTransition(selection,planOnly);
    }
    case 'postgres.transfer.plan': {
      const {operation:_operation,...selection}=operation;
      return planManagedPostgresTransfer(selection);
    }
    case 'postgres.source.recovery.inspect': return inspectRecoveryPostgresFingerprint(operation.generation, operation.backupDigest, operation.componentId, operation.serviceId, operation.inventoryDigest);
    case 'postgres.source.fingerprint': return fingerprintInstalledPostgresSource(operation.componentId, operation.release, operation.serviceId, operation.inventoryDigest);
    case 'postgres.plan': return reconcileLocalPostgres(operation.selections);
    case 'postgres.apply': return reconcileLocalPostgres(operation.selections, { topologyDigest: operation.topologyDigest, inventoryDigest: operation.inventoryDigest });
    case 'postgres.source.inspect': return inspectInstalledPostgresSource(operation.componentId, operation.release, operation.serviceId);
    case 'postgres.component.activate': return activateOrTransferPostgresComponent(operation.componentId, operation.selections, operation.backupGeneration);
  }
}

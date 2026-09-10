import type { SupervisorOperation } from './protocol.js';
import { reconcileLocalPostgres } from './postgres.js';
import { inspectInstalledPostgresSource, fingerprintInstalledPostgresSource } from './postgres-source.js';
import { activateLocalPostgresComponent } from './postgres-lifecycle.js';
import { inspectRecoveryPostgresFingerprint } from './postgres-source-backup.js';

type PostgresOperation = Extract<SupervisorOperation, { operation: 'postgres.plan' | 'postgres.apply' | 'postgres.source.inspect' | 'postgres.source.fingerprint' | 'postgres.source.recovery.inspect' | 'postgres.component.activate' }>;
const operations = new Set<PostgresOperation['operation']>(['postgres.plan','postgres.apply','postgres.source.inspect',
  'postgres.source.fingerprint','postgres.source.recovery.inspect','postgres.component.activate']);
export function isPostgresOperation(operation: SupervisorOperation): operation is PostgresOperation {
  return [...operations].some(name => name === operation.operation);
}

export function executePostgresOperation(operation: PostgresOperation) {
  switch (operation.operation) {
    case 'postgres.source.recovery.inspect': return inspectRecoveryPostgresFingerprint(operation.generation, operation.backupDigest, operation.componentId, operation.serviceId, operation.inventoryDigest);
    case 'postgres.source.fingerprint': return fingerprintInstalledPostgresSource(operation.componentId, operation.release, operation.serviceId, operation.inventoryDigest);
    case 'postgres.plan': return reconcileLocalPostgres(operation.selections);
    case 'postgres.apply': return reconcileLocalPostgres(operation.selections, { topologyDigest: operation.topologyDigest, inventoryDigest: operation.inventoryDigest });
    case 'postgres.source.inspect': return inspectInstalledPostgresSource(operation.componentId, operation.release, operation.serviceId);
    case 'postgres.component.activate': return activateLocalPostgresComponent(operation.componentId, operation.selections, operation.backupGeneration);
  }
}

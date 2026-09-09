import type { SupervisorOperation } from './protocol.js';
import { reconcileLocalPostgres } from './postgres.js';
import { inspectInstalledPostgresSource } from './postgres-source.js';
import { activateLocalPostgresComponent } from './postgres-lifecycle.js';

type PostgresOperation = Extract<SupervisorOperation, { operation: 'postgres.plan' | 'postgres.apply' | 'postgres.source.inspect' | 'postgres.component.activate' }>;

export function executePostgresOperation(operation: PostgresOperation) {
  switch (operation.operation) {
    case 'postgres.plan': return reconcileLocalPostgres(operation.selections);
    case 'postgres.apply': return reconcileLocalPostgres(operation.selections, { topologyDigest: operation.topologyDigest, inventoryDigest: operation.inventoryDigest });
    case 'postgres.source.inspect': return inspectInstalledPostgresSource(operation.componentId, operation.release, operation.serviceId);
    case 'postgres.component.activate': return activateLocalPostgresComponent(operation.componentId, operation.selections, operation.backupGeneration);
  }
}

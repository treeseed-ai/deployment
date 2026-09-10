import { lstatSync } from 'node:fs';
import { assertPostgresTransferNotHeld, postgresTransferHoldPath, postgresTransferJournalRoot } from '../core/postgres-transfer-hold.js';
import { PostgresTransferJournal } from '../postgres/transfer-journal.js';
import type { SupervisorOperation } from './protocol.js';

const containmentOperations = new Set([
  'supervisor.ping', 'compose.status', 'compose.stop', 'postgres.source.inspect', 'postgres.source.fingerprint',
  'host.development.status', 'provider.runtime.status', 'security.status', 'sandbox.status',
  'backup.inspect', 'backup.list', 'backup.create', 'recovery.restore',
  'development.backup.status', 'development.backup.fence',
  'postgres.transfer.status',
]);

/** Fixed boundary while a transfer may have changed data. In particular, do not
 * replace the manager with a version that does not understand the interlock.
 * Component package restoration cannot activate databases by itself.
 */
export function guardPostgresTransferOperation(operation: SupervisorOperation, marker = postgresTransferHoldPath) {
  if (containmentOperations.has(operation.operation)) return;
  if (operation.operation === 'apt.install' && operation.packages.every(name => /^treeseed-(?:component-[a-z0-9-]+|lab)=[0-9A-Za-z.+:~-]+$/u.test(name))) return;
  assertPostgresTransferNotHeld(marker);
}

export function activePostgresTransferJournal() {
  try { lstatSync(postgresTransferHoldPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('PostgreSQL transfer state unavailable'); }
  return new PostgresTransferJournal(postgresTransferJournalRoot, postgresTransferHoldPath);
}

import { lstatSync } from 'node:fs';

// Outside restored application/manager state, with a searchable parent so the
// unprivileged manager can detect the hold without reading root-only metadata.
export const postgresTransferHoldPath = '/var/lib/treeseed/postgres-transfer-hold.json';
export const postgresTransferJournalRoot = '/var/lib/treeseed/postgres-transfers';

export function assertPostgresTransferNotHeld(path = postgresTransferHoldPath) {
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('PostgreSQL transfer state unavailable; activation denied');
  }
  throw new Error('PostgreSQL transfer holds application activation; explicit coordinated recovery required');
}

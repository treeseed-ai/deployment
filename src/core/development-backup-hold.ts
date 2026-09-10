import { existsSync } from 'node:fs';

// Outside the archived manager/component state: restoring a backup must not
// erase the interlock. No credentials or source contents belong in this file.
export const developmentBackupHoldPath = '/var/lib/treeseed/development-backup-hold.json';

export function assertDevelopmentNotHeld(path = developmentBackupHoldPath) {
  if (existsSync(path)) throw new Error('Development is held for a coordinated backup/update; selection changes and automatic restart are blocked until recovery completes.');
}

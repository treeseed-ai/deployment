import { beforeEach, expect, it, vi } from 'vitest';
import { executeBackupOperation } from '../src/supervisor/backup-operations.js';

const f = vi.hoisted(() => ({ locked: false, active: vi.fn(), restored: vi.fn(), restore: vi.fn(), mark: vi.fn(), lock: vi.fn() }));
vi.mock('../src/supervisor/postgres-transfer-guard.js', () => ({ postgresTransferJournal: () => ({ locked: f.lock, active: f.active, restored: f.restored }) }));
vi.mock('../src/supervisor/backup.js', () => ({ restoreGenerationBackup: f.restore, createGenerationBackup: vi.fn(), inspectGenerationBackup: vi.fn(), listGenerationBackups: vi.fn() }));
vi.mock('../src/supervisor/development-backup.js', () => ({ developmentBackupDependencies: () => ({}), markDevelopmentBackupRestored: f.mark,
  beginDevelopmentBackup: vi.fn(), finishDevelopmentBackup: vi.fn(), developmentBackupStatus: vi.fn(), fenceDevelopmentBackup: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks(); f.locked = false;
  f.lock.mockImplementation(async (run: () => Promise<unknown>) => { f.locked = true; try { return await run(); } finally { f.locked = false; } });
  f.active.mockImplementation(() => { expect(f.locked).toBe(true); return { restoreGeneration: 7, restoreDigest: `sha256:${'a'.repeat(64)}` }; });
  f.restore.mockImplementation(async () => { expect(f.locked).toBe(true); return { generation: 7, sha256: 'a'.repeat(64) }; });
  f.restored.mockImplementation(() => { expect(f.locked).toBe(true); });
});
it('serializes exact authenticated restore and hold release under the transfer lock', async () => {
  await executeBackupOperation({ operation: 'recovery.restore', generation: 7 });
  expect(f.restore).toHaveBeenCalledWith(7,'a'.repeat(64)); expect(f.restored).toHaveBeenCalledWith(7,'a'.repeat(64));
  expect(f.locked).toBe(false);
});
it('rejects a wrong recovery generation after locking but before replacing data', async () => {
  await expect(executeBackupOperation({ operation: 'recovery.restore', generation: 8 })).rejects.toThrow('Exact coordinated');
  expect(f.restore).not.toHaveBeenCalled(); expect(f.restored).not.toHaveBeenCalled();
});
it('preserves the hold if authenticated restore fails', async () => {
  f.restore.mockRejectedValue(new Error('restore failed'));
  await expect(executeBackupOperation({ operation: 'recovery.restore', generation: 7 })).rejects.toThrow('restore failed');
  expect(f.restored).not.toHaveBeenCalled(); expect(f.mark).not.toHaveBeenCalled(); expect(f.locked).toBe(false);
});

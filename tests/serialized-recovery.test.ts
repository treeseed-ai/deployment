import { expect, it } from 'vitest';
import { serializedRecoveryArguments } from '../src/manager/serialized-recovery.js';
import { serializedReconcileArguments } from '../src/manager/serialized-reconcile.js';
import { backupArchiveArguments } from '../src/supervisor/backup.js';

it('serializes recovery with the exact updater lock and bounded generation argument', () => {
	const recovery = serializedRecoveryArguments(219);
	expect(recovery.slice(0, 6)).toEqual(serializedReconcileArguments().slice(0, 6));
	expect(recovery[6]).toMatch(/\/bin\/recovery\.js$/u);
	expect(recovery[7]).toBe('--generation=219');
	for (const value of [0, -1, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => serializedRecoveryArguments(value)).toThrow();
});

it('uses fast gzip without changing the encrypted gzip archive format', () => {
	expect(backupArchiveArguments('var/lib/treeseed/manager/test.json', [])).toContain('--use-compress-program=/usr/bin/gzip -1');
});

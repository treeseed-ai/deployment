import { expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { withReplacedBackupState } from '../src/supervisor/backup-state-replacement.js';

it('puts the current state back when extraction fails', async () => {
	const root = mkdtempSync(resolve(tmpdir(), 'treeseed-restore-failure-'));
	mkdirSync(`${root}/state`); writeFileSync(`${root}/state/current`, 'preserved');
	await expect(withReplacedBackupState(root, ['state'], async () => {
		mkdirSync(`${root}/state`); writeFileSync(`${root}/state/partial`, 'incomplete'); throw new Error('failed extraction');
	})).rejects.toThrow('failed extraction');
	expect(readFileSync(`${root}/state/current`, 'utf8')).toBe('preserved');
	expect(readdirSync(`${root}/state`)).toEqual(['current']);
	expect(readdirSync(root)).toEqual(['state']);
});

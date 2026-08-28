import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectGenerationBackup, listGenerationBackups } from '../src/supervisor/backup.js';

function backup(root: string, generation: number, valid = true) {
	const archive = resolve(root, `generation-${generation}.tar.gz`), content = `sealed-${generation}`;
	writeFileSync(archive, content);
	const sha256 = createHash('sha256').update(content).digest('hex');
	writeFileSync(`${archive}.sha256`, `${valid ? sha256 : '0'.repeat(64)}  generation-${generation}.tar.gz\n`);
}

describe('recovery backup discovery', () => {
	it('enumerates exact generations and validates archived managed state', () => {
		const root = mkdtempSync(resolve(tmpdir(), 'treeseed-recovery-backups-'));
		mkdirSync(root, { recursive: true });
		backup(root, 41); backup(root, 42);
		const reader = (_archive: string, member: string) => JSON.stringify(
			member.endsWith('platform.json') ? { configurationId: 'workstation' }
				: member.endsWith('current-receipt.json') ? { receiptId: 'receipt-known-good' }
					: [{ componentId: 'api', release: '1.0.0-1' }],
		);
		expect(inspectGenerationBackup(41, { backupRoot: root, reader })).toMatchObject({
			generation: 41,
			configuration: { configurationId: 'workstation' },
			receipt: { receiptId: 'receipt-known-good' },
			components: [{ componentId: 'api', release: '1.0.0-1' }],
		});
		expect(listGenerationBackups({ backupRoot: root, reader }).map(({ generation, valid }) => ({ generation, valid }))).toEqual([
			{ generation: 42, valid: true }, { generation: 41, valid: true },
		]);
	});

	it('reports checksum corruption without making it selectable', () => {
		const root = mkdtempSync(resolve(tmpdir(), 'treeseed-recovery-corrupt-'));
		backup(root, 99, false);
		expect(listGenerationBackups({ backupRoot: root })).toEqual([
			expect.objectContaining({ generation: 99, valid: false, error: expect.stringMatching(/checksum verification/u) }),
		]);
		expect(() => inspectGenerationBackup(100, { backupRoot: root })).toThrow(/does not exist/u);
	});
});

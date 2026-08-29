import { createCipheriv, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectGenerationBackup, listGenerationBackups } from '../src/supervisor/backup.js';

const key = Buffer.alloc(32, 7);
function backup(root: string, generation: number, valid = true) {
	const archive = resolve(root, `generation-${generation}.tar.gz.enc`), nonce = Buffer.alloc(12, generation % 255);
	const header = { schemaVersion: 'treeseed.encrypted-backup/v1', algorithm: 'aes-256-gcm', keyId: 'application-backup-kek-v1', generation, nonce: nonce.toString('base64url'), createdAt: '2026-08-29T00:00:00.000Z' };
	const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(header).sort(([left], [right]) => left.localeCompare(right))))));
	const plaintext = Buffer.from(`sealed-${generation}`), content = Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
	writeFileSync(archive, content); const sha256 = createHash('sha256').update(content).digest('hex');
	writeFileSync(`${archive}.sha256`, `${valid ? sha256 : '0'.repeat(64)}  generation-${generation}.tar.gz.enc\n`);
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
		expect(inspectGenerationBackup(41, { backupRoot: root, stagingRoot: root, reader, key })).toMatchObject({
			generation: 41,
			encrypted: true,
			configuration: { configurationId: 'workstation' },
			receipt: { receiptId: 'receipt-known-good' },
			components: [{ componentId: 'api', release: '1.0.0-1' }],
		});
		expect(listGenerationBackups({ backupRoot: root, stagingRoot: root, reader, key }).map(({ generation, valid }) => ({ generation, valid }))).toEqual([
			{ generation: 42, valid: true }, { generation: 41, valid: true },
		]);
	});

	it('reports checksum corruption without making it selectable', () => {
		const root = mkdtempSync(resolve(tmpdir(), 'treeseed-recovery-corrupt-'));
		backup(root, 99, false);
		expect(listGenerationBackups({ backupRoot: root, key })).toEqual([
			expect.objectContaining({ generation: 99, valid: false, error: expect.stringMatching(/checksum verification/u) }),
		]);
		expect(() => inspectGenerationBackup(100, { backupRoot: root })).toThrow(/does not exist/u);
	});

	it('rejects authenticated ciphertext tampering even when the outer checksum is replaced', () => {
		const root = mkdtempSync(resolve(tmpdir(), 'treeseed-recovery-auth-')); backup(root, 77);
		const archive = resolve(root, 'generation-77.tar.gz.enc'), content = readFileSync(archive), index = content.length - 17; content[index] = (content[index] ?? 0) ^ 1; writeFileSync(archive, content);
		writeFileSync(`${archive}.sha256`, `${createHash('sha256').update(content).digest('hex')}  generation-77.tar.gz.enc\n`);
		expect(() => inspectGenerationBackup(77, { backupRoot: root, stagingRoot: root, key })).toThrow();
	});
});

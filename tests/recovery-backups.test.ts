import { createCipheriv, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupArchiveArguments, inspectGenerationBackup, listGenerationBackups, restoreVerifiedBackup } from '../src/supervisor/backup.js';
import { host } from './fixtures.js';
import { requiredBackupState } from '../src/supervisor/backup-coverage.js';
import { deploymentDigest } from '@treeseed/sdk/deployment';

const key = Buffer.alloc(32, 7);
function backup(root: string, generation: number, valid = true, aiState = false, proposed = false) {
	const archive = resolve(root, `generation-${generation}.tar.gz.enc`), nonce = Buffer.alloc(12, generation % 255);
	const header = { schemaVersion: 'treeseed.encrypted-backup/v1', algorithm: 'aes-256-gcm', keyId: 'application-backup-kek-v1', generation, nonce: nonce.toString('base64url'), createdAt: '2026-08-29T00:00:00.000Z' };
	const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(header).sort(([left], [right]) => left.localeCompare(right))))));
	const source = resolve(root, `source-${generation}`);
	mkdirSync(`${source}/etc/treeseed`, { recursive: true }); mkdirSync(`${source}/var/lib/treeseed/manager`, { recursive: true });
	const configuration = host();
	if (aiState) {
		configuration.runtime = { management: 'managed', environment: 'development', dataRoot: '/var/lib/treeseed/development/.treeseed/data' };
		configuration.components['ai-inference'] = { ...configuration.components.api! };
	}
	const components = aiState ? [{componentId:'ai-inference'}] : [];
	const state = requiredBackupState(configuration, components);
	for (const path of state) { mkdirSync(`${source}/${path}`, { recursive: true }); writeFileSync(`${source}/${path}/identity`, 'synthetic-preserved-identity'); }
	writeFileSync(`${source}/etc/treeseed/platform.json`, JSON.stringify(proposed ? {...configuration,generation:configuration.generation+1} : configuration));
	writeFileSync(`${source}/var/lib/treeseed/manager/current-receipt.json`, JSON.stringify({ receiptId: 'receipt-known-good',configurationDigest:deploymentDigest(configuration) }));
	writeFileSync(`${source}/var/lib/treeseed/manager/active-components.json`, JSON.stringify(components));
	const configurationMember = `var/lib/treeseed/manager/backup-configuration-${generation}.json`;
	writeFileSync(`${source}/${configurationMember}`, JSON.stringify(configuration));
	const plaintext = execFileSync('/usr/bin/tar', backupArchiveArguments(configurationMember, ['etc/treeseed', 'var/lib/treeseed/manager/current-receipt.json', 'var/lib/treeseed/manager/active-components.json', configurationMember, ...state], source));
	const content = Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
	writeFileSync(archive, content); const sha256 = createHash('sha256').update(content).digest('hex');
	writeFileSync(`${archive}.sha256`, `${valid ? sha256 : '0'.repeat(64)}  generation-${generation}.tar.gz.enc\n`);
}

describe('recovery backup discovery', () => {
	it('archives the accepted settings exactly once when live settings already contain a proposal', async () => {
		const root = mkdtempSync(resolve(tmpdir(), 'treeseed-config-snapshot-')); backup(root, 45, true, false, true);
		const inspected = await inspectGenerationBackup(45, {backupRoot:root,key});
		expect(inspected.configuration).toEqual(host());
	});
	it('restores authenticated state to a disposable root and cleans its encrypted snapshot', async () => {
		const root = mkdtempSync(resolve(tmpdir(), 'treeseed-disposable-restore-')); backup(root, 43, true, true);
		const target = resolve(root, 'restored'); mkdirSync(target);
		await restoreVerifiedBackup(43, { backupRoot: root, destinationRoot: target, key, checkWriters: () => undefined });
		expect(JSON.parse(readFileSync(`${target}/etc/treeseed/platform.json`, 'utf8')).runtime.environment).toBe('development');
		for (const path of ['postgres','models','inference']) expect(readFileSync(`${target}/var/lib/treeseed/development/.treeseed/data/ai-inference/data/${path}/identity`, 'utf8')).toBe('synthetic-preserved-identity');
		expect(JSON.parse(readFileSync(`${target}/var/lib/treeseed/manager/current-receipt.json`, 'utf8'))).toMatchObject({receiptId:'receipt-known-good'});
		expect(readdirSync(root).filter(name => name.startsWith('restore-'))).toEqual([]);
	});
	it('never mutates a destination when authenticated inspection fails', async () => {
		const root = mkdtempSync(resolve(tmpdir(), 'treeseed-rejected-restore-')); backup(root, 44);
		const target = resolve(root, 'restored'); mkdirSync(target);
		await expect(restoreVerifiedBackup(44, { backupRoot: root, destinationRoot: target, key: Buffer.alloc(32, 9), checkWriters: () => undefined })).rejects.toThrow();
		expect(readdirSync(target)).toEqual([]);
		expect(readdirSync(root).filter(name => name.startsWith('restore-'))).toEqual([]);
	});
	it('enumerates exact generations and validates archived managed state', async () => {
		const root = mkdtempSync(resolve(tmpdir(), 'treeseed-recovery-backups-'));
		mkdirSync(root, { recursive: true });
		backup(root, 41); backup(root, 42);
		expect(await inspectGenerationBackup(41, { backupRoot: root, key })).toMatchObject({
			generation: 41,
			encrypted: true,
			configuration: host(),
			receipt: { receiptId: 'receipt-known-good' },
			components: [],
		});
		expect((await listGenerationBackups({ backupRoot: root, key })).map(({ generation, valid }) => ({ generation, valid }))).toEqual([
			{ generation: 42, valid: true }, { generation: 41, valid: true },
		]);
	});

	it('reports checksum corruption without making it selectable', async () => {
		const root = mkdtempSync(resolve(tmpdir(), 'treeseed-recovery-corrupt-'));
		backup(root, 99, false);
		expect(await listGenerationBackups({ backupRoot: root, key })).toEqual([
			expect.objectContaining({ generation: 99, valid: false, error: expect.stringMatching(/checksum verification/u) }),
		]);
		await expect(inspectGenerationBackup(100, { backupRoot: root })).rejects.toThrow(/does not exist/u);
	});

	it('rejects authenticated ciphertext tampering even when the outer checksum is replaced', async () => {
		const root = mkdtempSync(resolve(tmpdir(), 'treeseed-recovery-auth-')); backup(root, 77);
		const archive = resolve(root, 'generation-77.tar.gz.enc'), content = readFileSync(archive), index = content.length - 17; content[index] = (content[index] ?? 0) ^ 1; writeFileSync(archive, content);
		writeFileSync(`${archive}.sha256`, `${createHash('sha256').update(content).digest('hex')}  generation-77.tar.gz.enc\n`);
		await expect(inspectGenerationBackup(77, { backupRoot: root, key })).rejects.toThrow();
	});
});

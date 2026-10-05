import { existsSync, readFileSync } from 'node:fs';
import { deploymentDigest, hostConfigurationSchema, type HostConfiguration } from '@treeseed/sdk/deployment';
import { atomicJson } from '../core/files.js';
import { paths } from '../core/paths.js';

const savedPath = `${paths.managerState}/recovery-configuration.json`;
export function selectBackupConfiguration(current: unknown, receipt: {configurationDigest?: unknown}, saved?: unknown) {
	for (const candidate of [current, saved]) {
		const parsed = hostConfigurationSchema.safeParse(candidate);
		if (parsed.success && deploymentDigest(parsed.data) === receipt.configurationDigest) return parsed.data;
	}
	throw new Error('Backup configuration does not match the accepted generation receipt.');
}
export function preserveAcceptedConfiguration(current: HostConfiguration) {
	const receiptPath = `${paths.managerState}/current-receipt.json`;
	if (!existsSync(receiptPath)) return;
	const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
	if (deploymentDigest(current) === receipt.configurationDigest) atomicJson(savedPath, current, 0o600);
}
export function backupConfiguration(current: HostConfiguration) {
	const receipt = JSON.parse(readFileSync(`${paths.managerState}/current-receipt.json`, 'utf8'));
	return selectBackupConfiguration(current, receipt, existsSync(savedPath) ? JSON.parse(readFileSync(savedPath, 'utf8')) : undefined);
}

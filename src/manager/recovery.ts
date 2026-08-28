import {
	componentReleaseSchema,
	hostConfigurationSchema,
	hostReceiptSchema,
	type ComponentRelease,
	type HostConfiguration,
	type HostReceipt,
} from '@treeseed/sdk/deployment';
import { atomicJson } from '../core/files.js';
import { recordEvent } from '../core/events.js';
import { paths } from '../core/paths.js';
import { renderCaddyfile, subjectAlternativeNames } from '../edge/caddy.js';
import { requestSupervisor } from '../supervisor/client.js';
import { loadHostConfiguration } from '../core/configuration.js';
import { loadActiveComponents, loadCurrentReceipt } from './current-state.js';
import {
	activateComponent,
	componentActivationOrder,
	componentStopOrder,
	enrollProvider,
	rollbackRoutes,
	stopComponent,
} from './reconcile.js';

export interface RecoveryBackupInspection {
	generation: number;
	sha256: string;
	configuration: unknown;
	receipt: unknown;
	components: unknown;
}

export interface RecoveryBackupSummary {
	generation: number;
	sha256?: string;
	valid: boolean;
	error?: string;
	receipt?: unknown;
	components?: unknown;
}

function parsedInspection(value: RecoveryBackupInspection) {
	return {
		generation: value.generation,
		sha256: value.sha256,
		configuration: hostConfigurationSchema.parse(value.configuration),
		receipt: hostReceiptSchema.parse(value.receipt),
		components: componentReleaseSchema.array().parse(value.components),
	};
}

function packageSelections(receipt: HostReceipt) {
	return receipt.packages
		.sort((left, right) => left.order - right.order)
		.map(({ name, version }) => `${name}=${version}`);
}

async function applyRoutes(host: HostConfiguration, components: ComponentRelease[]) {
	const routes = rollbackRoutes(host, components);
	if (routes.length) await requestSupervisor({ operation: 'edge.apply', caddyfile: renderCaddyfile(routes), aliases: subjectAlternativeNames(routes) });
}

async function activateGeneration(host: HostConfiguration, components: ComponentRelease[]) {
	for (const component of componentActivationOrder(host, components)) {
		await activateComponent(host, component, components);
		await enrollProvider(host, component);
	}
	await applyRoutes(host, components);
}

async function stopGeneration(host: HostConfiguration, components: ComponentRelease[]) {
	for (const component of componentStopOrder(host, components)) await stopComponent(component);
}

function persistRestoredReceipt(target: HostReceipt, components: ComponentRelease[]) {
	const receipt = hostReceiptSchema.parse({
		...target,
		receiptId: `receipt-${Date.now()}`,
		state: 'known-good',
		completedAt: new Date().toISOString(),
	});
	atomicJson(`${paths.receipts}/${receipt.receiptId}.json`, receipt);
	atomicJson(`${paths.managerState}/current-receipt.json`, receipt);
	atomicJson(`${paths.managerState}/active-components.json`, components);
	return receipt;
}

export async function listRecoveryBackups() {
	const backups = await requestSupervisor<RecoveryBackupSummary[]>({ operation: 'backup.list' });
	return backups.map((backup) => {
		if (!backup.valid) return { generation: backup.generation, valid: false, error: backup.error };
		const receipt = hostReceiptSchema.safeParse(backup.receipt);
		const components = componentReleaseSchema.array().safeParse(backup.components);
		return {
			generation: backup.generation,
			valid: receipt.success && components.success,
			sha256: backup.sha256,
			receipt: receipt.success ? {
				receiptId: receipt.data.receiptId,
				catalogDigest: receipt.data.catalogDigest,
				completedAt: receipt.data.completedAt,
				packages: receipt.data.packages,
			} : null,
			components: components.success ? components.data.map(({ componentId, release }) => ({ componentId, release })) : [],
			...(!receipt.success || !components.success ? { error: 'Backup does not contain a complete managed generation.' } : {}),
		};
	});
}

export async function inspectRecoveryBackup(generation: number) {
	return parsedInspection(await requestSupervisor<RecoveryBackupInspection>({ operation: 'backup.inspect', generation }));
}

export async function restoreManagedGeneration(generation: number) {
	const target = await inspectRecoveryBackup(generation);
	const currentHost = loadHostConfiguration(), currentComponents = loadActiveComponents(), currentReceipt = loadCurrentReceipt();
	if (!currentReceipt) throw new Error('A current known-good receipt is required before manual recovery.');
	const safetyGeneration = Date.now();
	await requestSupervisor({ operation: 'backup.create', generation: safetyGeneration });
	recordEvent('recovery.restore-started', { generation, targetReceiptId: target.receipt.receiptId, safetyGeneration });
	try {
		await stopGeneration(currentHost, currentComponents);
		const packages = packageSelections(target.receipt);
		if (packages.length) await requestSupervisor({ operation: 'apt.install', packages });
		await requestSupervisor({ operation: 'recovery.restore', generation });
		await activateGeneration(target.configuration, target.components);
		const receipt = persistRestoredReceipt(target.receipt, target.components);
		recordEvent('recovery.restore-complete', { generation, receiptId: receipt.receiptId, targetReceiptId: target.receipt.receiptId });
		return { generation, restored: true, safetyGeneration, targetReceiptId: target.receipt.receiptId, receipt };
	} catch (error) {
		recordEvent('recovery.restore-rollback-started', { generation, safetyGeneration, message: error instanceof Error ? error.message : String(error) });
		try { await stopGeneration(target.configuration, target.components); } catch { /* continue restoring the safety generation */ }
		const packages = packageSelections(currentReceipt);
		if (packages.length) await requestSupervisor({ operation: 'apt.install', packages });
		await requestSupervisor({ operation: 'recovery.restore', generation: safetyGeneration });
		await activateGeneration(currentHost, currentComponents);
		recordEvent('recovery.restore-rollback-complete', { generation, safetyGeneration, receiptId: currentReceipt.receiptId });
		throw error;
	}
}

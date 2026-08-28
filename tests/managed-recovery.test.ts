import { mkdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { component, hash, host } from './fixtures.js';

const state = vi.hoisted(() => ({
	operations: [] as any[], events: [] as any[], writes: [] as any[], lifecycle: [] as string[],
	currentHost: undefined as any, currentComponents: [] as any[], currentReceipt: undefined as any,
	target: undefined as any, activationFailure: false,
}));

vi.mock('../src/core/paths.js', () => ({ paths: { receipts: '/tmp/treeseed-recovery-test/receipts', managerState: '/tmp/treeseed-recovery-test/manager' } }));
vi.mock('../src/core/configuration.js', () => ({ loadHostConfiguration: () => state.currentHost }));
vi.mock('../src/manager/current-state.js', () => ({ loadActiveComponents: () => state.currentComponents, loadCurrentReceipt: () => state.currentReceipt }));
vi.mock('../src/core/files.js', () => ({ atomicJson: (path: string, value: unknown) => state.writes.push({ path, value }) }));
vi.mock('../src/core/events.js', () => ({ recordEvent: (type: string, details: unknown) => state.events.push({ type, details }) }));
vi.mock('../src/edge/caddy.js', () => ({ renderCaddyfile: () => 'managed routes', subjectAlternativeNames: () => ['api.treeseed.localhost'] }));
vi.mock('../src/manager/reconcile.js', () => ({
	componentActivationOrder: (_host: unknown, components: any[]) => components,
	componentStopOrder: (_host: unknown, components: any[]) => [...components].reverse(),
	stopComponent: async (item: any) => state.lifecycle.push(`stop:${item.release}`),
	activateComponent: async (_host: unknown, item: any) => {
		state.lifecycle.push(`activate:${item.release}`);
		if (state.activationFailure) { state.activationFailure = false; throw new Error('target health failed'); }
	},
	enrollProvider: async (_host: unknown, item: any) => state.lifecycle.push(`enroll:${item.release}`),
	rollbackRoutes: () => [{ alias: 'api.treeseed.localhost', upstream: 'http://api:8787', authentication: 'none' }],
}));
vi.mock('../src/supervisor/client.js', () => ({ requestSupervisor: async (operation: any) => {
	state.operations.push(operation);
	if (operation.operation === 'backup.inspect') return state.target;
	return {};
} }));

const { inspectRecoveryBackup, restoreManagedGeneration } = await import('../src/manager/recovery.js');

function receipt(configuration: any, components: any[], id: string) {
	return {
		schemaVersion: 'treeseed.host-receipt/v1', receiptId: id, planId: `${id}-plan`, state: 'known-good', hostId: configuration.host.id,
		role: configuration.host.role, rolloutGroup: configuration.fleet.rolloutGroup, configurationDigest: deploymentDigest(configuration), catalogDigest: hash(id === 'receipt-current' ? 'c' : 'd'),
		packages: components.flatMap((item) => item.packages), images: components.flatMap((item) => item.images),
		runtimes: components.map((item) => ({ componentId: item.componentId, release: item.release, runtimeDigest: item.runtimeDigest })),
		completedAt: '2026-08-27T00:00:00.000Z',
	};
}

describe('complete managed generation recovery', () => {
	it('validates the target before mutation and restores packages, services, routes, and receipt custody', async () => {
		mkdirSync('/tmp/treeseed-recovery-test/receipts', { recursive: true });
		state.currentHost = host();
		const current = component('api', 'development', 'a'); current.release = '2.0.0-1'; current.applicationVersion = current.release; current.runtime.version = current.release; current.packages[0]!.version = current.release;
		const target = component('api', 'development', 'b'); target.release = '1.0.0-1'; target.applicationVersion = target.release; target.runtime.version = target.release; target.packages[0]!.version = target.release;
		state.currentComponents = [current]; state.currentReceipt = receipt(state.currentHost, [current], 'receipt-current');
		state.target = { generation: 73, sha256: hash('backup'), configuration: state.currentHost, receipt: receipt(state.currentHost, [target], 'receipt-generation-73'), components: [target] };
		state.operations = []; state.events = []; state.writes = []; state.lifecycle = []; state.activationFailure = false;

		expect((await inspectRecoveryBackup(73)).receipt.receiptId).toBe('receipt-generation-73');
		state.operations = [];
		const restored = await restoreManagedGeneration(73);
		expect(restored).toMatchObject({ generation: 73, restored: true, targetReceiptId: 'receipt-generation-73' });
		expect(state.operations.map(({ operation }) => operation)).toEqual([
			'backup.inspect', 'backup.create', 'apt.install', 'recovery.restore', 'edge.apply',
		]);
		expect(state.operations.find(({ operation }) => operation === 'apt.install').packages).toEqual(['treeseed-component-api=1.0.0-1']);
		expect(state.lifecycle).toEqual(['stop:2.0.0-1', 'activate:1.0.0-1', 'enroll:1.0.0-1']);
		expect(state.writes.map(({ path }) => path)).toEqual([
			expect.stringMatching(/receipts\/receipt-/u),
			'/tmp/treeseed-recovery-test/manager/current-receipt.json',
			'/tmp/treeseed-recovery-test/manager/active-components.json',
		]);
		expect(state.events.map(({ type }) => type).at(-1)).toBe('recovery.restore-complete');
	});

	it('automatically restores the safety generation when target health fails', async () => {
		state.currentHost = host();
		const current = component('api', 'stable', 'a'), target = component('api', 'stable', 'b');
		state.currentComponents = [current]; state.currentReceipt = receipt(state.currentHost, [current], 'receipt-current');
		state.target = { generation: 73, sha256: hash('e'), configuration: state.currentHost, receipt: receipt(state.currentHost, [target], 'receipt-generation-73'), components: [target] };
		state.operations = []; state.events = []; state.writes = []; state.lifecycle = []; state.activationFailure = true;

		await expect(restoreManagedGeneration(73)).rejects.toThrow(/target health failed/u);
		const safety = state.operations.find(({ operation }) => operation === 'backup.create').generation;
		expect(state.operations.filter(({ operation }) => operation === 'apt.install').map(({ packages }) => packages)).toEqual([
			['treeseed-component-api=1.0.0'], ['treeseed-component-api=1.0.0'],
		]);
		expect(state.operations.some(({ operation, generation }) => operation === 'recovery.restore' && generation === safety)).toBe(true);
		const safetyRestore = state.operations.findIndex(({ operation, generation }) => operation === 'recovery.restore' && generation === safety);
		const rollbackInstall = state.operations.map(({ operation }) => operation).lastIndexOf('apt.install');
		expect(safetyRestore).toBeLessThan(rollbackInstall);
		expect(state.lifecycle).toEqual([
			'stop:1.0.0', 'activate:1.0.0', 'stop:1.0.0', 'activate:1.0.0', 'enroll:1.0.0',
		]);
		expect(state.events.map(({ type }) => type).at(-1)).toBe('recovery.restore-rollback-complete');
	});
});

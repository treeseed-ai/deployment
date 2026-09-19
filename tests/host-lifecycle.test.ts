import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
	stopped: false,
	live: false,
	suspended: false,
	hold: false,
	stopFailure: false,
	startFailure: false,
	stops: [] as string[],
	reconciles: 0,
}));

vi.mock('../src/core/development-backup-hold.js', () => ({
	assertDevelopmentNotHeld: () => { if (state.hold) throw new Error('backup held'); },
}));
vi.mock('../src/core/configuration.js', () => ({ loadHostConfiguration: () => ({}) }));
vi.mock('../src/manager/current-state.js', () => ({
	loadActiveComponents: () => [{ componentId: 'api' }, { componentId: 'treedx' }],
	loadCurrentReceipt: () => ({ receiptId: 'known-good' }),
}));
vi.mock('../src/manager/component-order.js', () => ({ componentStopOrder: () => [{ componentId: 'treedx' }, { componentId: 'api' }] }));
vi.mock('../src/manager/development-sessions.js', () => ({
	DevelopmentSessionStore: class { list() { return state.live ? [{ session: { status: state.suspended ? 'suspended' : 'active', targets: [{ mode: 'live' }] } }] : []; } },
}));
vi.mock('../src/manager/reconcile.js', () => ({
	reconcile: async () => { state.reconciles++; if (state.startFailure) throw new Error('activation failed'); return { receiptId: 'new-known-good' }; },
	stopComponent: async (component: { componentId: string }) => {
		state.stops.push(component.componentId);
		if (state.stopFailure && component.componentId === 'api') throw new Error('stop failed');
	},
}));
vi.mock('../src/manager/update-state.js', () => ({
	runtimeStopped: () => state.stopped,
	setRuntimeStopped: (value: boolean) => { state.stopped = value; },
}));

const { startHostWorkloads, stopHostWorkloads } = await import('../src/manager/host-lifecycle.js');

beforeEach(() => { state.stopped = false; state.live = false; state.suspended = false; state.hold = false; state.stopFailure = false; state.startFailure = false; state.stops = []; state.reconciles = 0; });

describe('host lifecycle under the manager authority', () => {
	it('fences updates before reverse-order stop, preserves the manager, and repeats as noop', async () => {
		expect(await stopHostWorkloads()).toEqual({ state: 'stopped', changed: true });
		expect(state.stopped).toBe(true);
		expect(state.stops).toEqual(['treedx', 'api']);
		expect(await stopHostWorkloads()).toEqual({ state: 'stopped', changed: false });
		expect(state.stops).toHaveLength(2);
	});

	it('starts once through reconciliation and repeats without mutation', async () => {
		state.stopped = true;
		expect(await startHostWorkloads()).toMatchObject({ state: 'running', changed: true, receipt: { receiptId: 'new-known-good' } });
		expect(state.reconciles).toBe(1);
		expect(await startHostWorkloads()).toMatchObject({ state: 'running', changed: false, receipt: { receiptId: 'known-good' } });
		expect(state.reconciles).toBe(1);
	});

	it('retains stopped fence and stops partial activation when start fails', async () => {
		state.stopped = true; state.startFailure = true;
		await expect(startHostWorkloads()).rejects.toThrow('activation failed');
		expect(state.stopped).toBe(true);
		expect(state.stops).toEqual(['treedx', 'api']);
	});

	it('retains stopped fence and reports component failure without restarting it', async () => {
		state.stopFailure = true;
		await expect(stopHostWorkloads()).rejects.toThrow('api');
		expect(state.stopped).toBe(true);
		expect(state.reconciles).toBe(0);
	});

	it('refuses backup hold or live development without changing workloads', async () => {
		state.hold = true;
		await expect(stopHostWorkloads()).rejects.toThrow('backup held');
		state.hold = false; state.live = true;
		await expect(stopHostWorkloads()).rejects.toThrow('coordinated development pause');
		expect(state.stopped).toBe(false);
		expect(state.stops).toEqual([]);
		state.suspended = true;
		expect(await stopHostWorkloads()).toMatchObject({ state: 'stopped', changed: true });
	});
});

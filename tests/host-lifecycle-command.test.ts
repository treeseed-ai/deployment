import { beforeEach, describe, expect, it, vi } from 'vitest';
import { host } from './fixtures.js';

const state = vi.hoisted(() => ({ stopped: false, calls: [] as unknown[], replacements: [] as unknown[] }));
vi.mock('../src/core/configuration.js', () => ({
	tryLoadHostConfiguration: () => host(), loadHostConfiguration: () => host(),
}));
vi.mock('../src/manager/update-state.js', () => ({
	runtimeStopped: () => state.stopped,
	loadUpdateState: () => ({ runtimeStopped: state.stopped, stablePaused: false, developmentPaused: false }),
}));
vi.mock('../src/manager/serialized-reconcile.js', () => ({
	serializedHostLifecycle: async (action: string) => { state.calls.push(action); return { state: action === 'stop' ? 'stopped' : 'running', changed: true }; },
	serializedHostConfigurationStage: async (configuration: unknown) => {
		state.calls.push('stage'); state.replacements.push({ operation: 'configuration.replace', configuration });
		return { staged: true, configurationId: (configuration as { configurationId: string }).configurationId,
			generation: (configuration as { generation: number }).generation, lifecycle: 'stopped' };
	},
	serializedReconcile: async () => { state.calls.push('reconcile'); return { receiptId: 'known-good' }; },
}));
vi.mock('../src/manager/configuration-preflight.js', () => ({
	configurationPlan: (candidate: unknown) => ({ plan: { blockers: [] }, candidate }),
}));
vi.mock('../src/supervisor/client.js', () => ({
	requestSupervisor: async (request: unknown) => { state.replacements.push(request); return request; },
}));
const { executeHostCommand } = await import('../src/manager/operations.js');
const command = (handlerId: string, options: Record<string, unknown> = {}, configuration?: unknown) => ({ handlerId, arguments: [], options, ...(configuration ? { configuration } : {}) });

beforeEach(() => { state.stopped = false; state.calls = []; state.replacements = []; });

describe('host lifecycle command authority', () => {
	it('plans start and stop without a lifecycle mutation', async () => {
		for (const action of ['start', 'stop']) {
			const result = await executeHostCommand(command(`local.host.${action}`, { plan: true }), { local: true });
			expect(result).toMatchObject({ action, lifecycle: 'running', mutation: false });
		}
		expect(state.calls).toEqual([]);
	});

	it('rejects remote control before planning or dispatch, including config staging', async () => {
		for (const action of ['start', 'stop']) {
			await expect(executeHostCommand(command(`local.host.${action}`, { plan: true }), { local: false })).rejects.toThrow('protected local manager socket');
		}
		await expect(executeHostCommand(command('local.host.config.stage', { plan: true }, host()), { local: false })).rejects.toThrow('protected local manager socket');
		expect(state.calls).toEqual([]); expect(state.replacements).toEqual([]);
	});

	it('dispatches start/stop once and exposes the stopped state in status', async () => {
		expect(await executeHostCommand(command('local.host.stop'), { local: true })).toMatchObject({ state: 'stopped', changed: true });
		state.stopped = true;
		expect(await executeHostCommand(command('local.host.status'), { local: true })).toMatchObject({ lifecycle: 'stopped', updates: { runtimeStopped: true } });
		expect(await executeHostCommand(command('local.host.start'), { local: true })).toMatchObject({ state: 'running', changed: true });
		expect(state.calls).toEqual(['stop', 'start']);
	});

	it('requires stopped state to stage configuration and never reconciles on stage', async () => {
		const candidate = host(); candidate.generation += 1;
		await expect(executeHostCommand(command('local.host.config.stage', { plan: true }, candidate), { local: true })).rejects.toThrow('Stop host workloads');
		state.stopped = true;
		const plan = await executeHostCommand(command('local.host.config.stage', { plan: true }, candidate), { local: true });
		expect(plan).toMatchObject({ plan: { blockers: [] } });
		expect(state.replacements).toEqual([]);
		const result = await executeHostCommand(command('local.host.config.stage', {}, candidate), { local: true });
		expect(result).toMatchObject({ staged: true, lifecycle: 'stopped', generation: candidate.generation });
		expect(state.replacements).toEqual([{ operation: 'configuration.replace', configuration: candidate }]);
		expect(state.calls).toEqual(['stage']);
	});

	it('changes a component selection while stopped without activating it', async () => {
		state.stopped = true;
		const result = await executeHostCommand({ handlerId: 'local.host.component.disable', arguments: ['agent'], options: {} }, { local: true });
		expect(result).toMatchObject({ receiptId: 'known-good' });
		expect(state.replacements).toHaveLength(1);
		expect(state.replacements[0]).toMatchObject({ operation: 'configuration.replace', configuration: { generation: 2, components: { agent: { enabled: false } } } });
		expect(state.calls).toEqual(['reconcile']);
	});
});

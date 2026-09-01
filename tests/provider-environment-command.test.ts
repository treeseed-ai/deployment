import { beforeEach, describe, expect, it, vi } from 'vitest';
import { host } from './fixtures.js';

const state = vi.hoisted(() => ({ operations: [] as unknown[] }));
vi.mock('../src/core/configuration.js', () => ({ tryLoadHostConfiguration: () => host(), loadHostConfiguration: () => host() }));
vi.mock('../src/supervisor/client.js', () => ({ requestSupervisor: async (operation: unknown) => { state.operations.push(operation); return operation; } }));
const { executeHostCommand } = await import('../src/manager/operations.js');

describe('provider environment manager boundary', () => {
	beforeEach(() => { state.operations = []; });

	it('rejects every environment operation outside the protected local socket', async () => {
		await expect(executeHostCommand({ handlerId: 'local.host.provider.environment.list', arguments: [], options: {} }, { local: false })).rejects.toThrow(/protected local manager socket/u);
		await expect(executeHostCommand({ handlerId: 'local.host.provider.environment.set', arguments: ['runtime', 'TOKEN'], options: { payload: JSON.stringify({ profileId: 'runtime', name: 'TOKEN', value: 'secret' }) } }, { local: false })).rejects.toThrow(/protected local manager socket/u);
		expect(state.operations).toEqual([]);
	});

	it('forwards protected values only through the fixed supervisor protocol', async () => {
		const value = 'private-value';
		const result = await executeHostCommand({ handlerId: 'local.host.provider.environment.set', arguments: ['runtime', 'TOKEN'], options: { payload: JSON.stringify({ profileId: 'runtime', name: 'TOKEN', value }) } }, { local: true });
		expect(result).toEqual({ operation: 'provider.environment.set', profileId: 'runtime', name: 'TOKEN', value });
		expect(state.operations).toEqual([result]);
	});

	it('keeps plans value-free and does not invoke the supervisor', async () => {
		const result = await executeHostCommand({ handlerId: 'local.host.provider.environment.rotate', arguments: ['runtime', 'TOKEN'], options: { plan: true, payload: JSON.stringify({ profileId: 'runtime', name: 'TOKEN' }) } }, { local: true });
		expect(result).toEqual({ action: 'rotate', profileId: 'runtime', name: 'TOKEN', mutation: false });
		expect(state.operations).toEqual([]);
	});

	it('maps read, import, unset, and verify operations without arbitrary paths', async () => {
		await executeHostCommand({ handlerId: 'local.host.provider.environment.list', arguments: [], options: {} }, { local: true });
		await executeHostCommand({ handlerId: 'local.host.provider.environment.verify', arguments: ['runtime'], options: {} }, { local: true });
		await executeHostCommand({ handlerId: 'local.host.provider.environment.import', arguments: ['runtime'], options: { payload: JSON.stringify({ profileId: 'runtime', envFile: 'TOKEN=value\n' }) } }, { local: true });
		await executeHostCommand({ handlerId: 'local.host.provider.environment.unset', arguments: ['runtime', 'TOKEN'], options: { payload: JSON.stringify({ profileId: 'runtime', name: 'TOKEN' }) } }, { local: true });
		expect(state.operations).toEqual([
			{ operation: 'provider.environment.list' }, { operation: 'provider.environment.show', profileId: 'runtime' },
			{ operation: 'provider.environment.import', profileId: 'runtime', envFile: 'TOKEN=value\n' }, { operation: 'provider.environment.unset', profileId: 'runtime', name: 'TOKEN' },
		]);
	});
});

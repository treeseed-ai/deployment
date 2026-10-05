import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ operations: [] as unknown[], safetyRoots: [] as string[] }));
vi.mock('../src/core/configuration.js', () => ({ tryLoadHostConfiguration: () => undefined, loadHostConfiguration: () => { throw new Error('not configured'); } }));
vi.mock('../src/supervisor/client.js', () => ({ requestSupervisor: async (operation: unknown) => { state.operations.push(operation); return operation; } }));
vi.mock('../src/manager/reset-safety.js', () => ({ assertTreeDxResetSafe: async (root: string) => { state.safetyRoots.push(root); } }));

const { executeHostCommand } = await import('../src/manager/operations.js');

describe('host uninstall command boundary', () => {
	beforeEach(() => { state.operations = []; state.safetyRoots = []; });

	it('allows plan only through the protected local socket', async () => {
		const request = { handlerId: 'local.host.uninstall', arguments: [], options: { plan: true } };
		await expect(executeHostCommand(request, { local: false })).rejects.toThrow(/protected local manager socket/iu);
		await expect(executeHostCommand(request, { local: true })).resolves.toMatchObject({ operation: 'platform.uninstall.plan' });
		expect(state.operations).toEqual([{ operation: 'platform.uninstall.plan' }]);
	});

	it('fails incomplete authorization before safety checks or supervisor mutation', async () => {
		await expect(executeHostCommand({ handlerId: 'local.host.uninstall', arguments: [], options: { confirm: true } }, { local: true })).rejects.toThrow(/--confirm and --yes/iu);
		expect(state.safetyRoots).toEqual([]); expect(state.operations).toEqual([]);
	});

	it('checks unpublished TreeDX work before scheduling an explicitly selected purge', async () => {
		await executeHostCommand({ handlerId: 'local.host.uninstall', arguments: [], options: { confirm: true, yes: true, purgeSecurity: true } }, { local: true });
		expect(state.safetyRoots).toEqual(['/var/lib/treeseed/components']);
		expect(state.operations).toEqual([{ operation: 'platform.uninstall.execute', purgeSecurity: true, confirm: true }]);
	});
});

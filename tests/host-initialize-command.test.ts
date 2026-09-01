import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hostInitializationProfileSchema, type HostConfiguration, type ReleaseCatalog } from '@treeseed/sdk/deployment';
import { component, hash } from './fixtures.js';

const state = vi.hoisted(() => ({ stable: undefined as ReleaseCatalog | undefined, development: undefined as ReleaseCatalog | undefined,
	current: undefined as HostConfiguration | undefined, operations: [] as unknown[] }));
vi.mock('../src/catalog/load.js', () => ({ loadCatalog: (path: string) => path.includes('development') ? state.development : state.stable }));
vi.mock('../src/core/configuration.js', () => ({ tryLoadHostConfiguration: () => state.current, loadHostConfiguration: () => {
	if (!state.current) throw new Error('not configured'); return state.current;
} }));
vi.mock('../src/supervisor/client.js', () => ({ requestSupervisor: async (operation: unknown) => { state.operations.push(operation); return operation; } }));

const { executeHostCommand } = await import('../src/manager/operations.js');

function catalogs(withInputs = false) {
	const lab = component('lab', 'development', 'f', 'lab.treeseed.localhost');
	const profile = hostInitializationProfileSchema.parse({ schemaVersion: 'treeseed.host-initialization-profile/v1', id: withInputs ? 'capacity-provider' : 'core',
		role: withInputs ? 'capacity-provider' : 'integrated', runtime: { management: 'managed', environment: 'track-default' }, components: ['lab'], security: { requirement: 'none' },
		inputs: withInputs ? [{ name: 'teamRegistrationCode', required: true, sensitive: true, description: 'Team registration code' }] : [] });
	state.stable = { schemaVersion: 'treeseed.release-catalog/v1', release: '1.0.0', generation: 1, track: 'stable', compatibilityId: 'treeseed-linux-amd64-v1', catalogDigest: hash('a'), stableBase: null, components: [lab], hostProfiles: [profile], createdAt: '2026-09-01T00:00:00.000Z' };
	state.development = { schemaVersion: 'treeseed.release-catalog/v1', release: '1.1.0~rc1', generation: 2, track: 'development', compatibilityId: 'treeseed-linux-amd64-v1', catalogDigest: hash('d'), stableBase: { release: '1.0.0', catalogDigest: hash('a') }, components: [lab], hostProfiles: [profile], createdAt: '2026-09-01T00:01:00.000Z' };
}

describe('host initialize command boundary', () => {
	beforeEach(() => { state.current = undefined; state.operations = []; catalogs(); });

	it('plans without mutation and initializes a zero-input profile once', async () => {
		const plan = await executeHostCommand({ handlerId: 'local.host.initialize', arguments: [], options: { plan: true, profile: 'core' } }, { local: true });
		expect(plan).toMatchObject({ mode: 'plan', profile: 'core', mutation: false, configured: false, inputs: [] });
		expect(state.operations).toEqual([]);
		const result = await executeHostCommand({ handlerId: 'local.host.initialize', arguments: [], options: { profile: 'core', confirm: true, payload: JSON.stringify({
			profile: 'core', hostId: (plan as { hostId: string }).hostId, catalog: (plan as { catalog: unknown }).catalog, inputs: {},
		}) } }, { local: true });
		expect(result).toMatchObject({ mode: 'execute', profile: 'core', mutation: true, initialized: true, generation: 1, nextAction: 'host reconcile' });
		expect(state.operations).toHaveLength(1);
		expect(state.operations[0]).toMatchObject({ operation: 'configuration.initialize', configuration: { schemaVersion: 'treeseed.host/v1', generation: 1, components: { lab: { profile: 'core' } } } });
	});

	it('keeps external-input profiles blocked without supervisor mutation', async () => {
		catalogs(true);
		const plan = await executeHostCommand({ handlerId: 'local.host.initialize', arguments: [], options: { plan: true, profile: 'capacity-provider' } }, { local: true }) as { hostId: string; catalog: unknown };
		await expect(executeHostCommand({ handlerId: 'local.host.initialize', arguments: [], options: { profile: 'capacity-provider', confirm: true,
			payload: JSON.stringify({ profile: 'capacity-provider', hostId: plan.hostId, catalog: plan.catalog, inputs: { teamRegistrationCode: 'registration-code' } }) } }, { local: true })).rejects.toThrow(/external inputs remain disabled/u);
		expect(state.operations).toEqual([]);
	});

	it('rejects a moved catalog binding before supervisor mutation', async () => {
		const plan = await executeHostCommand({ handlerId: 'local.host.initialize', arguments: [], options: { plan: true, profile: 'core' } }, { local: true }) as { hostId: string; catalog: Record<string, unknown> };
		await expect(executeHostCommand({ handlerId: 'local.host.initialize', arguments: [], options: { profile: 'core', confirm: true, payload: JSON.stringify({
			profile: 'core', hostId: plan.hostId, catalog: { ...plan.catalog, digest: `sha256:${'f'.repeat(64)}` }, inputs: {},
		}) } }, { local: true })).rejects.toThrow(/immutable catalog-bound plan/u);
		expect(state.operations).toEqual([]);
	});

	it('rejects nonlocal execution before rendering', async () => {
		await expect(executeHostCommand({ handlerId: 'local.host.initialize', arguments: [], options: { plan: true, profile: 'core' } }, { local: false })).rejects.toThrow(/protected local manager socket/u);
		expect(state.operations).toEqual([]);
	});
});

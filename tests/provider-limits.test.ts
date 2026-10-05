import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { host } from './fixtures.js';

vi.mock('@treeseed/sdk/capacity-provider', () => ({ validateCapacityProviderManifestV5: () => ({ ok: true, diagnostics: [] }) }));
const { setProviderLimits, showProviderLimits } = await import('../src/manager/provider-limits.js');

function configured() {
	const value = host();
	const manifest = { schemaVersion: 5, adapters: [
		{ id: 'codex-implementation', nativeLimits: { modelConfigurationId: 'luna-low', dailyActiveSecondsLimit: 43_200,
			capabilityLimits: { acting: { dailyActiveSecondsLimit: 43_200 }, planning: { dailyActiveSecondsLimit: 43_200 } } } },
		{ id: 'codex-research', nativeLimits: { modelConfigurationId: 'luna-research', dailyActiveSecondsLimit: 7_200,
			capabilityLimits: { research: { dailyActiveSecondsLimit: 7_200 } } } },
	] };
	value.components.agent!.configuration = { files: { 'treeseed.capacity-provider.yaml': YAML.stringify(manifest) } };
	return value;
}

describe('managed provider limit controls', () => {
	it('changes only the selected model and its capabilities, preserving identity and other supply', () => {
		const current = configured();
		const { candidate, changed } = setProviderLimits(current, { providerId: 'codex-implementation', dailyActiveSecondsLimit: 64_800, expectedGeneration: current.generation });
		expect(changed).toBe(true);
		expect(candidate.generation).toBe(current.generation + 1);
		expect(showProviderLimits(current).executionProviders[0]!.dailyActiveSecondsLimit).toBe(43_200);
		expect(showProviderLimits(candidate).executionProviders).toMatchObject([
			{ id: 'codex-implementation', dailyActiveSecondsLimit: 64_800, capabilityLimits: { acting: { dailyActiveSecondsLimit: 64_800 }, planning: { dailyActiveSecondsLimit: 64_800 } } },
			{ id: 'codex-research', dailyActiveSecondsLimit: 7_200 },
		]);
	});

	it('updates one capability without multiplying the shared model cap', () => {
		const next = setProviderLimits(configured(), { providerId: 'codex-implementation', capabilityId: 'planning', dailyActiveSecondsLimit: 3_600 }).candidate;
		expect(showProviderLimits(next).executionProviders[0]).toMatchObject({ dailyActiveSecondsLimit: 43_200,
			capabilityLimits: { acting: { dailyActiveSecondsLimit: 43_200 }, planning: { dailyActiveSecondsLimit: 3_600 } } });
	});

	it('keeps the current generation when the requested limit is already configured', () => {
		const current = configured();
		const result = setProviderLimits(current, { providerId: 'codex-implementation', dailyActiveSecondsLimit: 43_200 });
		expect(result.changed).toBe(false);
		expect(result.limits.generation).toBe(current.generation);
	});

	it('rejects stale generation, unknown resources and invalid values before mutation', () => {
		const current = configured();
		expect(() => setProviderLimits(current, { providerId: 'codex-implementation', dailyActiveSecondsLimit: 1, expectedGeneration: current.generation - 1 })).toThrow(/Stale/u);
		expect(() => setProviderLimits(current, { providerId: 'missing', dailyActiveSecondsLimit: 1 })).toThrow(/not configured/u);
		expect(() => setProviderLimits(current, { providerId: 'codex-implementation', capabilityId: 'missing', dailyActiveSecondsLimit: 1 })).toThrow(/not configured/u);
		expect(() => setProviderLimits(current, { providerId: 'codex-implementation', dailyActiveSecondsLimit: -1 })).toThrow(/nonnegative/u);
		expect(showProviderLimits(current).executionProviders[0]!.dailyActiveSecondsLimit).toBe(43_200);
	});
});

import { describe, expect, it } from 'vitest';
import { reconcileDevelopmentConfiguration } from '../src/core/development-configuration.js';
import { host } from './fixtures.js';

function integratedHost() {
	const value = host();
	value.runtime.environment = 'development';
	value.runtime.dataRoot = '/var/lib/treeseed/development/.treeseed/data';
	value.components.treedx = { enabled: true, track: 'development', aliases: {}, resources: { gpuDevices: [] }, connections: {}, configuration: {} };
	return value;
}

describe('managed development TreeDX configuration', () => {
	it('adds only canonical public values and fixed secret references once', () => {
		const first = reconcileDevelopmentConfiguration(integratedHost());
		expect(first.changed).toBe(true);
		expect(first.configuration.generation).toBe(2);
		expect(first.configuration.components.treedx?.configuration).toMatchObject({
			environment: { TREEDX_JWT_ALLOWED_ALGS: 'RS256', TREEDX_JWT_AUDIENCE: 'treedx' },
			secretEnvironment: { TREEDX_SECRET_KEY_BASE: 'treedx-secret-key-base' },
		});
		expect(first.configuration.secrets['treedx-secret-key-base']?.reference).toBe('/etc/treeseed/credentials/treedx-secret-key-base');
		const replay = reconcileDevelopmentConfiguration(first.configuration);
		expect(replay).toEqual({ changed: false, configuration: first.configuration });
	});

	it('does not mutate production and rejects conflicting local custody', () => {
		expect(reconcileDevelopmentConfiguration(host()).changed).toBe(false);
		const conflicting = integratedHost();
		conflicting.components.treedx!.configuration = { environment: { TREEDX_JWT_AUDIENCE: 'other' } };
		expect(() => reconcileDevelopmentConfiguration(conflicting)).toThrow(/conflicts with the development profile/u);
	});
});

import { describe, expect, it } from 'vitest';
import { componentStateRoot, renderComponentEnvironment } from '../src/supervisor/component.js';
import { host } from './fixtures.js';

describe('managed Agent state root', () => {
	it('binds secured Agent state to the encrypted provider mount', () => {
		const configuration = host();
		configuration.runtime = { management: 'managed', environment: 'development', dataRoot: '/var/lib/treeseed/development/.treeseed/data' };
		configuration.security = { providerVolume: { mountPath: '/var/lib/treeseed/agent' } } as typeof configuration.security;
		expect(componentStateRoot(configuration, 'agent')).toBe('/var/lib/treeseed/agent');
		expect(componentStateRoot(configuration, 'api')).toBe('/var/lib/treeseed/development/.treeseed/data/api');
		expect(renderComponentEnvironment(configuration, 'agent')).toContain('TREESEED_COMPONENT_DATA_ROOT="/var/lib/treeseed/agent"');
	});
});

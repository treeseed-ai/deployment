import { describe, expect, it } from 'vitest';
import { renderComponentEnvironment } from '../src/supervisor/component.js';
import { host } from './fixtures.js';

describe('development connection precedence', () => {
	it('uses managed peer URLs during custody rendering without weakening production collisions', () => {
		const configuration = host();
		configuration.components.api!.configuration = { environment: { TREESEED_TREEDX_URL: 'http://treedx:4000' } };
		const connections = { TREESEED_TREEDX_URL: 'http://host.docker.internal:4000' };
		expect(() => renderComponentEnvironment(configuration, 'api', connections)).toThrow(/reserved for a managed connection/u);
		configuration.runtime = { management: 'managed', environment: 'development', dataRoot: '/work/platform/.treeseed/data' };
		const rendered = renderComponentEnvironment(configuration, 'api', connections);
		expect(rendered).toContain('TREESEED_TREEDX_URL="http://host.docker.internal:4000"');
		expect(rendered).not.toContain('TREESEED_TREEDX_URL="http://treedx:4000"');
	});
});

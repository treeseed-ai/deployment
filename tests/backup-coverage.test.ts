import { describe, expect, it } from 'vitest';
import { host } from './fixtures.js';
import { assertBackupCoverage, requiredBackupState } from '../src/supervisor/backup-coverage.js';

describe('configured backup state coverage', () => {
	it('requires the configured development root, not the production fallback', () => {
		const configuration = host();
		configuration.runtime = { management: 'managed', environment: 'development', dataRoot: '/var/lib/treeseed/development/.treeseed/data' };
		configuration.components['ai-inference'] = { ...configuration.components.api! };
		const components = [{ componentId: 'ai-inference' }];
		const roots = requiredBackupState(configuration, components);
		expect(roots).toContain('var/lib/treeseed/development/.treeseed/data/ai-inference/data/postgres');
		expect(() => assertBackupCoverage(configuration, components, ['var/lib/treeseed/components/ai-inference/data/postgres/'])).toThrow(/incomplete/);
		expect(assertBackupCoverage(configuration, components, roots.map(root => `${root}/`)).verified).toBe(true);
	});
	it('rejects missing inventory and path traversal in an archive', () => {
		expect(() => requiredBackupState(host(), null)).toThrow(/inventory/);
		expect(() => assertBackupCoverage(host(), [], ['../escape'])).toThrow(/unsafe/);
	});
});

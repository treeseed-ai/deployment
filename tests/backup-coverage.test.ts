import { describe, expect, it } from 'vitest';
import { host } from './fixtures.js';
import { assertBackupCoverage, assertBackupEntries, requiredBackupState } from '../src/supervisor/backup-coverage.js';

describe('configured backup state coverage', () => {
	it('rejects unowned paths, special files, duplicate members and link escapes', () => {
		for (const entries of [
			[{path:'etc/passwd',type:'File'}],
			[{path:'etc/treeseed/socket',type:'FIFO'}],
			[{path:'etc/treeseed/a',type:'File'},{path:'etc/treeseed/a',type:'File'}],
			[{path:'etc/treeseed/a',type:'SymbolicLink',linkpath:'../../outside'}],
			[{path:'etc/treeseed/a',type:'Link',linkpath:'etc/treeseed/missing'}],
			[{path:'etc/treeseed/a',type:'SymbolicLink',linkpath:'b'},{path:'etc/treeseed/a/file',type:'File'}],
		]) expect(() => assertBackupEntries(host(), [], entries)).toThrow();
	});
	it('accepts owned regular files and bounded relative links', () => {
		expect(assertBackupEntries(host(), [], [
			{path:'etc/treeseed/',type:'Directory'},
			{path:'etc/treeseed/data',type:'File'},
			{path:'etc/treeseed/link',type:'SymbolicLink',linkpath:'data'},
		]).verified).toBe(true);
	});
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

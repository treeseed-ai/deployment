import { describe, expect, it } from 'vitest';
import { renderComponentEnvironment } from '../src/supervisor/component.js';
import { host } from './fixtures.js';

describe('optional component secret environment', () => {
	it('omits only absent optional inputs', () => {
		const configuration = host();
		configuration.components.api!.configuration = { secretEnvironment: { TREESEED_GITHUB_TOKEN: 'github-repository-token' } };
		configuration.secrets['github-repository-token'] = { provider: 'file', reference: '/etc/treeseed/credentials/github-repository-token' };
		const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
		expect(renderComponentEnvironment(configuration, 'api', {}, () => { throw missing; }, ['TREESEED_GITHUB_TOKEN'])).not.toContain('TREESEED_GITHUB_TOKEN');
		expect(() => renderComponentEnvironment(configuration, 'api', {}, () => { throw missing; })).toThrow('missing');
		expect(() => renderComponentEnvironment(configuration, 'api', {}, () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }, ['TREESEED_GITHUB_TOKEN'])).toThrow('denied');
		expect(renderComponentEnvironment(configuration, 'api', {}, () => 'present', ['TREESEED_GITHUB_TOKEN'])).toContain('TREESEED_GITHUB_TOKEN="present"');
	});
});

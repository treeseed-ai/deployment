import { describe, expect, it } from 'vitest';
import { executeSupervisorOperation } from '../src/supervisor/execute.js';

describe('supervisor compose stop', () => {
	it('does not require a removed compose bundle when every project container is stopped', () => {
		const calls: Array<readonly string[]> = [];
		executeSupervisorOperation({ operation: 'compose.stop', componentId: 'agent', files: ['agent/missing/compose.yml'], projectName: 'treeseed-agent' }, (_executable, arguments_) => {
			calls.push(arguments_);
			return arguments_[0] === 'ps' ? '' : undefined;
		});
		expect(calls).toEqual([['ps', '--quiet', '--filter', 'label=com.docker.compose.project=treeseed-agent']]);
	});
});

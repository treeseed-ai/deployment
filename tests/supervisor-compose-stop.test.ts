import { describe, expect, it } from 'vitest';
import { executeSupervisorOperation } from '../src/supervisor/execute.js';

describe('supervisor compose stop', () => {
	it('does not enroll a provider when activating an auxiliary project or a non-manager service', () => {
		for (const operation of [
			{projectName:'treeseed-provider-custody',services:['inventory']},
			{projectName:'treeseed-agent',services:['runner']},
		]) {
			const calls: Array<readonly string[]> = [];
			executeSupervisorOperation({operation:'compose.activate',componentId:'agent',files:['agent/compose.yml'],waitTimeoutSeconds:30,...operation}, (_executable,args)=>{calls.push(args);return '';},()=>undefined);
			expect(calls.some(args=>args.includes('enroll'))).toBe(false);
			expect(calls.some(args=>args.includes('up'))).toBe(true);
		}
	});
	it('does not require a removed compose bundle when every project container is stopped', () => {
		const calls: Array<readonly string[]> = [];
		executeSupervisorOperation({ operation: 'compose.stop', componentId: 'agent', files: ['agent/missing/compose.yml'], projectName: 'treeseed-agent' }, (_executable, arguments_) => {
			calls.push(arguments_);
			return arguments_[0] === 'ps' ? '' : undefined;
		}, () => undefined);
		expect(calls).toEqual([['ps', '--quiet', '--filter', 'label=com.docker.compose.project=treeseed-agent']]);
	});

	it('stops project-labelled containers when the prior compose bundle was removed', () => {
		const calls: Array<readonly string[]> = [];
		let running = ['api-1', 'api-worker-1'];
		executeSupervisorOperation({ operation: 'compose.stop', componentId: 'api', files: ['api/removed/compose.yml'], projectName: 'treeseed-api' }, (_executable, arguments_) => {
			calls.push(arguments_);
			if (arguments_[0] === 'ps') return running.join('\n');
			if (arguments_[0] === 'compose') throw new Error('compose bundle missing');
			if (arguments_[0] === 'stop') running = [];
			return undefined;
		}, () => undefined);
		expect(calls).toContainEqual(['stop', 'api-1', 'api-worker-1']);
		expect(running).toEqual([]);
	});
});

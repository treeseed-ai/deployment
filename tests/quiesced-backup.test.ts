import { expect, it } from 'vitest';
import { component } from './fixtures.js';
import { quiescedBackup } from '../src/manager/quiesced-backup.js';

it('restores accepted configuration before rematerializing stopped services after capture failure', async () => {
	const current = component('api', 'development', 'a'), calls: string[] = [];
	await expect(quiescedBackup([current], [current], {
		stop: async () => { calls.push('stop'); },
		capture: async () => { calls.push('capture'); throw new Error('capture failed'); },
		rollbackConfiguration: async () => { calls.push('restore-accepted-configuration'); },
		start: async () => { calls.push('configure-and-activate'); },
	})).rejects.toThrow('capture failed');
	expect(calls).toEqual(['stop', 'capture', 'restore-accepted-configuration', 'configure-and-activate']);
});

it('prepares candidate holds before shutdown and resumes only after accepted restoration', async () => {
	const current = component('api', 'development', 'a'), calls: string[] = [];
	await expect(quiescedBackup([current], [current], {
		prepare: async () => { calls.push('hold'); }, stop: async () => { calls.push('stop'); },
		capture: async () => { calls.push('capture'); throw new Error('capture failed'); },
		rollbackConfiguration: async () => { calls.push('restore'); }, start: async () => { calls.push('activate'); },
		resumeAfterFailure: async () => { calls.push('resume'); },
	})).rejects.toThrow('capture failed');
	expect(calls).toEqual(['hold', 'stop', 'capture', 'restore', 'activate', 'resume']);
});

it('does not disrupt released services when candidate preflight fails', async () => {
	const current = component('api', 'development', 'a'), calls: string[] = [];
	await expect(quiescedBackup([current], [current], {
		prepare: async () => { throw new Error('unknown writer'); }, stop: async () => { calls.push('stop'); },
		capture: async () => { calls.push('capture'); }, start: async () => { calls.push('start'); },
	})).rejects.toThrow('unknown writer'); expect(calls).toEqual([]);
});

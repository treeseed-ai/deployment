import { describe, expect, it } from 'vitest';
import { supervisorOperationSchema } from '../src/supervisor/protocol.js';

describe('protected provider enrollment contract', () => {
	it('updates only bounded concurrency through the existing completion handoff', () => {
		const base = { operation: 'provider.enrollment-handoff', files: ['agent/release/compose.yml'], projectName: 'treeseed-agent' };
		const payload = { action: 'complete', connectionId: 'local-team' };
		expect(supervisorOperationSchema.safeParse({ ...base, payload: { ...payload, maxConcurrentRunners: 5 } }).success).toBe(true);
		for (const maxConcurrentRunners of [0, -1, 1.5, 1_025, '5']) expect(supervisorOperationSchema.safeParse({ ...base, payload: { ...payload, maxConcurrentRunners } }).success).toBe(false);
		expect(supervisorOperationSchema.safeParse({ ...base, payload: { ...payload, credential: 'forbidden' } }).success).toBe(false);
	});
	it('accepts only the canonical registration code, never a retired alias', () => {
		const base = { operation: 'provider.enrollment-handoff', files: ['agent/release/compose.yml'], projectName: 'treeseed-agent' };
		const begin = { action: 'begin', connectionId: 'local-team', teamId: 'team-id', controlPlaneUrl: 'http://api:3000', controlPlaneAudience: 'https://api.treeseed.localhost' };
		expect(supervisorOperationSchema.safeParse({ ...base, payload: { ...begin, registrationCode: 'registration-code' } }).success).toBe(true);
		expect(supervisorOperationSchema.safeParse({ ...base, payload: { ...begin, enrollmentToken: 'retired-token' } }).success).toBe(false);
		expect(supervisorOperationSchema.safeParse({ ...base, payload: { ...begin, registrationCode: 'registration-code', enrollmentToken: 'retired-token' } }).success).toBe(false);
	});
});

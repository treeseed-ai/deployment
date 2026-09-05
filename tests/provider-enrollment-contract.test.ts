import { describe, expect, it } from 'vitest';
import { supervisorOperationSchema } from '../src/supervisor/protocol.js';

describe('protected provider enrollment contract', () => {
	it('accepts only the canonical registration code, never a retired alias', () => {
		const base = { operation: 'provider.enrollment-handoff', files: ['agent/release/compose.yml'], projectName: 'treeseed-agent' };
		const begin = { action: 'begin', connectionId: 'local-team', teamId: 'team-id', controlPlaneUrl: 'http://api:3000', controlPlaneAudience: 'https://api.treeseed.localhost' };
		expect(supervisorOperationSchema.safeParse({ ...base, payload: { ...begin, registrationCode: 'registration-code' } }).success).toBe(true);
		expect(supervisorOperationSchema.safeParse({ ...base, payload: { ...begin, enrollmentToken: 'retired-token' } }).success).toBe(false);
		expect(supervisorOperationSchema.safeParse({ ...base, payload: { ...begin, registrationCode: 'registration-code', enrollmentToken: 'retired-token' } }).success).toBe(false);
	});
});

import { describe, expect, it, vi } from 'vitest';
import { supervisorOperationSchema } from '../src/supervisor/protocol.js';
import { executeSupervisorOperation } from '../src/supervisor/execute.js';
import { DevelopmentSessionStore } from '../src/manager/development-sessions.js';

describe('unified host manager foundation', () => {
	it('hands provider enrollment to the fixed packaged Agent entrypoint without token arguments', () => {
		// This UNIT supplies released selection; it must not consume the operator's live host sessions.
		const selection = vi.spyOn(DevelopmentSessionStore.prototype, 'list').mockReturnValue([]);
		try {
			const calls: Array<{ executable: string; arguments: readonly string[]; input: string | undefined }> = [];
			const result = executeSupervisorOperation({ operation: 'provider.enrollment-handoff', payload: { action: 'begin', connectionId: 'local-team', teamId: 'team-id', controlPlaneUrl: 'http://api:3000', controlPlaneAudience: 'https://api.treeseed.localhost', registrationCode: 'one-time-secret' }, files: ['agent/release/compose.yml'], projectName: 'treeseed-agent' }, (executable, arguments_, input) => {
				calls.push({ executable, arguments: arguments_, input });
				return JSON.stringify({ ok: true, connectionId: 'local-team', state: 'pending-approval', requestId: 'request-123' });
			});
			expect(result).toEqual({ ok: true, connectionId: 'local-team', state: 'pending-approval', requestId: 'request-123' });
			expect(calls[0]?.arguments).toEqual(['compose', '--env-file', '/etc/treeseed/components/agent/environment', '--file', '/usr/share/treeseed/components/agent/release/compose.yml', '--project-name', 'treeseed-agent', 'run', '--rm', '--no-deps', '-T', 'manager', 'enroll', '--json']);
			expect(calls[0]?.arguments.join(' ')).not.toContain('one-time-secret');
			expect(JSON.parse(calls[0]!.input!)).toMatchObject({ action: 'begin', connectionId: 'local-team', registrationCode: 'one-time-secret' });
			expect(selection).toHaveBeenCalledTimes(1);
		} finally { selection.mockRestore(); }
	});
});

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

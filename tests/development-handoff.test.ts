import { expect, it, vi } from 'vitest';
import type { ManagedDevelopmentSession } from '../src/manager/development-sessions.js';

const request = vi.fn();
vi.mock('../src/supervisor/client.js', () => ({ requestSupervisor: request }));
const { developmentHeldComponentIds, heldDevelopmentCredentialsMissing, resumeDevelopmentSessions } = await import('../src/manager/development-handoff.js');

function session(targets: Array<{ projectId: string; targetId: string; mode: string; kind: string }>) {
	return { session: { sessionId: 'dev-acceptance', targets }, runtimes: targets.map((target) => ({
		project: { id: target.projectId }, targets: [{ id: target.targetId, kind: target.kind }],
	})) } as unknown as ManagedDevelopmentSession;
}

it('keeps the installed Identity service running when only its package source is live', () => {
	const record = session([
		{ projectId: 'identity', targetId: 'package', mode: 'live', kind: 'package-watch' },
		{ projectId: 'api', targetId: 'service', mode: 'live', kind: 'live-api' },
		{ projectId: 'agent', targetId: 'sandbox', mode: 'candidate', kind: 'rebuild-restart' },
		{ projectId: 'treedx', targetId: 'service', mode: 'released', kind: 'live-api' },
	]);
	expect([...developmentHeldComponentIds([record])].sort()).toEqual(['agent', 'api']);
});

it('reports source recovery pending without changing installed-component custody', async () => {
	request.mockResolvedValueOnce({ ready: true }).mockResolvedValueOnce({ ready: false });
	const record = session([{ projectId: 'api', targetId: 'service', mode: 'live', kind: 'live-api' }]);
	expect(await resumeDevelopmentSessions([record])).toBe(true);
	expect(await resumeDevelopmentSessions([record])).toBe(false);
	expect(request).toHaveBeenCalledWith({ operation: 'development.boot.resume', sessionId: 'dev-acceptance' });
});

it('restages only missing manager-owned credentials for a development-held runtime', () => {
	expect(heldDevelopmentCredentialsMissing({ issues: [{ reason: 'runtime-credential-unavailable' }] })).toBe(true);
	expect(heldDevelopmentCredentialsMissing({ issues: [{ reason: 'configuration-unavailable' }] })).toBe(true);
	expect(heldDevelopmentCredentialsMissing({ issues: [{ reason: 'stopped' }] })).toBe(false);
	expect(heldDevelopmentCredentialsMissing({})).toBe(false);
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { affectedDevelopmentClosure, DevelopmentSessionStore } from '../src/manager/development-sessions.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function runtime(project = 'admin', target = 'web', dependency?: { id: string; target: string; reaction: string }) {
	return {
		schemaVersion: 'treeseed.development-runtime/v1', project: { id: project, repository: `treeseed-ai/${project}` }, defaults: { leaseSeconds: 3_600, restoreOnFailure: true },
		targets: [{ id: target, kind: project === 'agent' ? 'rebuild-restart' : project === 'sdk' ? 'package-watch' : 'live-web', platforms: ['linux-amd64'], runtimeRequirements: ['node>=22'], sourceRoots: ['src'], ignoredPaths: [],
			operations: project === 'sdk' ? { watch: { command: 'npm', args: ['run', 'build:watch'], environment: {}, timeoutSeconds: 600 } } : { start: { command: 'npm', args: ['run', 'dev'], environment: {}, timeoutSeconds: 600 } },
			ready: project === 'sdk' ? { kind: 'marker', path: 'dist/.complete', timeoutSeconds: 30 } : { kind: 'http', path: '/healthz', expectedStatus: 200, timeoutSeconds: 30 },
			outputs: [], endpoints: project === 'sdk' ? [] : [{ id: 'http', protocol: 'http', port: 4322, canonicalAlias: `${project}.treeseed.localhost`, visibility: 'host', authentication: 'application' }],
			dependencies: dependency ? [{ ...dependency, locality: 'either' }] : [], statePolicy: 'stateless', migrationPolicy: 'none', secretRefs: {}, shutdown: { graceSeconds: 30, activeWorkPolicy: 'block' }, resources: {}, logs: [], forbiddenOperations: [], promotion: { liveAdmissible: false, candidateRequiresVerification: true } }],
	};
}

function session(now: Date, sessionId = 'session-1') {
	const expiresAt = new Date(now.getTime() + 60_000).toISOString();
	return { schemaVersion: 'treeseed.development-session/v1', sessionId, actor: 'developer', hostId: 'host-1', createdAt: now.toISOString(), expiresAt, status: 'planning',
		repositories: [{ projectId: 'admin', repository: 'treeseed-ai/admin', worktree: '/workspace/admin', commit: 'a'.repeat(40), branch: 'staging', dirty: false, dirtyDigest: null, recipeDigest: `sha256:${'b'.repeat(64)}` }],
		targets: [{ projectId: 'admin', targetId: 'web', mode: 'live', generation: 0, health: 'pending' }],
		leases: [{ kind: 'alias', resource: 'admin.treeseed.localhost', acquiredAt: now.toISOString(), expiresAt }], restoredReceiptId: null, blockers: [] };
}

function store(now: Date) {
	const root = mkdtempSync(join(tmpdir(), 'treeseed-dev-sessions-')); roots.push(root);
	return new DevelopmentSessionStore(root, { now: () => now, directHealth: async () => true, routedHealth: async () => true });
}

describe('development session manager', () => {
	it('leases a canonical route only after direct readiness', async () => {
		const now = new Date('2026-08-26T12:00:00.000Z'), sessions = store(now);
		sessions.start(session(now), [runtime()]);
		await sessions.attach('session-1', 'admin', 'web', 4322);
		expect(sessions.activeRoutes([{ alias: 'admin.treeseed.localhost', upstream: 'admin:4322', authentication: 'application' }])).toEqual([
			{ alias: 'admin.treeseed.localhost', upstream: 'http://host.docker.internal:4322', authentication: 'application' },
		]);
		expect(await sessions.verifyRouted('session-1', 'admin', 'web')).toBe(true);
	});

	it('rejects a conflicting canonical lease and restores the base route on stop', async () => {
		const now = new Date('2026-08-26T12:00:00.000Z'), sessions = store(now);
		sessions.start(session(now), [runtime()]);
		expect(() => sessions.start(session(now, 'session-2'), [runtime()])).toThrow(/conflict/i);
		await sessions.attach('session-1', 'admin', 'web', 4322); sessions.stop('session-1');
		expect(sessions.activeRoutes([{ alias: 'admin.treeseed.localhost', upstream: 'admin:4322', authentication: 'application' }])[0]?.upstream).toBe('admin:4322');
	});

	it('expires bounded leases and removes their routes', async () => {
		const started = new Date('2026-08-26T12:00:00.000Z'); let now = started;
		const root = mkdtempSync(join(tmpdir(), 'treeseed-dev-sessions-')); roots.push(root);
		const sessions = new DevelopmentSessionStore(root, { now: () => now, directHealth: async () => true, routedHealth: async () => true });
		sessions.start(session(started), [runtime()]); await sessions.attach('session-1', 'admin', 'web', 4322);
		now = new Date(started.getTime() + 120_000);
		expect(sessions.activeRoutes([])).toEqual([]);
		expect(sessions.load('session-1').session.status).toBe('expired');
	});

	it('computes only directional declared consumers', () => {
		const closure = affectedDevelopmentClosure([runtime('sdk', 'package'), runtime('admin', 'web', { id: 'sdk', target: 'package', reaction: 'reload' }), runtime('agent', 'service')], ['sdk.package']);
		expect(closure).toEqual([{ key: 'sdk.package', reaction: 'none' }, { key: 'admin.web', reaction: 'reload' }]);
	});
});

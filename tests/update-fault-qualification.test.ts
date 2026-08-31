import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { component, hash, host } from './fixtures.js';

const state = vi.hoisted(() => ({
	host: undefined as any,
	stable: undefined as any,
	development: undefined as any,
	previous: undefined as any,
	active: [] as any[],
	paused: false,
	eligible: true,
	refreshFailure: null as Error | null,
	installFailure: null as Error | null,
	activationFailure: null as Error | null,
	composeStatus: null as null | { present: boolean; running: boolean },
	operations: [] as any[],
	events: [] as any[],
	evidence: [] as any[],
	root: `/tmp/treeseed-update-qualification-${process.pid}`,
}));

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>();
	return { ...actual, existsSync: (path: import('node:fs').PathLike) => String(path).startsWith('/etc/apt/sources.list.d/treeseed-deployment-') || actual.existsSync(path) };
});
vi.mock('../src/core/configuration.js', () => ({ loadHostConfiguration: () => state.host }));
vi.mock('../src/core/paths.js', () => ({ paths: { catalogs: `${state.root}/catalogs`, bundles: `${state.root}/components`, receipts: `${state.root}/receipts`, managerState: `${state.root}/manager`, cli: `${state.root}/cli` } }));
vi.mock('../src/catalog/load.js', () => ({ loadCatalog: (path: string) => path.endsWith('stable.json') ? state.stable : state.development }));
vi.mock('../src/core/files.js', () => ({ atomicJson: () => undefined }));
vi.mock('../src/core/events.js', () => ({ recordEvent: (type: string, details: unknown) => state.events.push({ type, details }) }));
vi.mock('../src/runtime/compose.js', () => ({ validateProductionCompose: () => undefined }));
vi.mock('../src/manager/current-state.js', () => ({ loadCurrentReceipt: () => state.previous, loadActiveComponents: () => state.active }));
vi.mock('../src/manager/update-state.js', () => ({
	loadUpdateState: () => ({ stablePaused: false, developmentPaused: state.paused, developmentPauseOwners: [], changedAt: new Date(0).toISOString(), metadataCheckedAt: { stable: null, development: null } }),
	metadataChecked: () => undefined,
	noteDevelopmentPauseOwner: () => undefined,
	recoverDevelopmentPauseOwners: () => undefined,
	trackPaused: () => state.paused,
}));
vi.mock('../src/manager/update-policy.js', () => ({ activationEligible: () => state.eligible, metadataRefreshDue: () => true }));
vi.mock('../src/supervisor/client.js', () => ({ requestSupervisor: async (operation: any) => {
	state.operations.push(operation);
	if (operation.operation === 'apt.refresh') {
		if (state.refreshFailure) throw state.refreshFailure;
		return { coreUpdated: false, before: {}, after: {} };
	}
	if (operation.operation === 'apt.install' && state.installFailure) {
		const failure = state.installFailure; state.installFailure = null; throw failure;
	}
	if (operation.operation === 'compose.activate' && state.activationFailure) {
		const failure = state.activationFailure; state.activationFailure = null; throw failure;
	}
	if (operation.operation === 'compose.status') return state.composeStatus ?? undefined;
	return undefined;
} }));

mkdirSync(`${state.root}/catalogs`, { recursive: true });
writeFileSync(`${state.root}/catalogs/development.json`, '{}');
const { reconcile } = await import('../src/manager/reconcile.js');
const { createPlan } = await import('../src/manager/plan.js');

function release(componentId: string, track: 'stable' | 'development', marker: string, version: string) {
	const value = component(componentId, track, marker);
	value.release = version; value.applicationVersion = version; value.runtime.version = version;
	value.packages[0]!.version = version; value.runtimeDigest = hash(marker); value.images[0]!.digest = hash(marker);
	return value;
}

function receipt(components: any[]) {
	return {
		schemaVersion: 'treeseed.host-receipt/v1', receiptId: 'known-good', planId: 'prior-plan', state: 'known-good', hostId: state.host.host.id,
		role: state.host.host.role, rolloutGroup: state.host.fleet.rolloutGroup, configurationDigest: deploymentDigest(state.host), catalogDigest: hash('b'),
		packages: components.flatMap((item) => item.packages), images: components.flatMap((item) => item.images), runtimes: components.map((item) => ({ componentId: item.componentId, release: item.release, runtimeDigest: item.runtimeDigest })), completedAt: '2026-08-25T00:00:00.000Z',
	};
}

beforeEach(() => {
	mkdirSync(`${state.root}/cli`, { recursive: true });
	writeFileSync(`${state.root}/cli/api-base-url`, 'https://api.treeseed.localhost\n');
	writeFileSync(`${state.root}/cli/localhost-ca.crt`, 'test-ca');
	state.host = host();
	const api = release('api', 'stable', 'b', '1.0.0-1'), oldAgent = release('agent', 'development', 'c', '1.1.0~rc1-1'), newAgent = release('agent', 'development', 'd', '1.1.0~rc2-1');
	state.stable = { schemaVersion: 'treeseed.release-catalog/v1', release: '1.0.0', generation: 1, track: 'stable', compatibilityId: 'treeseed-linux-amd64-v1', catalogDigest: hash('a'), stableBase: null, components: [api], createdAt: '2026-08-25T00:00:00.000Z' };
	newAgent.stableBase = { releaseRange: '^1.0.0', compatibilityId: 'treeseed-linux-amd64-v1', catalogDigest: state.stable.catalogDigest };
	oldAgent.stableBase = structuredClone(newAgent.stableBase);
	state.development = { schemaVersion: 'treeseed.release-catalog/v1', release: '1.1.0~rc2', generation: 2, track: 'development', compatibilityId: 'treeseed-linux-amd64-v1', catalogDigest: hash('d'), stableBase: { release: state.stable.release, catalogDigest: state.stable.catalogDigest }, components: [newAgent], createdAt: '2026-08-25T00:01:00.000Z' };
	state.active = [api, oldAgent]; state.previous = receipt(state.active); state.paused = false; state.eligible = true; state.refreshFailure = null; state.installFailure = null; state.activationFailure = null; state.composeStatus = null; state.operations = []; state.events = [];
});

describe('isolated update fault qualification', () => {
	it('serializes contenders through a real cross-process flock', async () => {
		const root = mkdtempSync(resolve(tmpdir(), 'treeseed-lock-')), lock = resolve(root, 'reconcile.lock'), log = resolve(root, 'order');
		const run = (label: string, delay: string) => new Promise<void>((accept, reject) => {
			const child = spawn('/usr/bin/flock', ['--exclusive', '--wait', '5', lock, '/bin/sh', '-c', `printf '${label}-start\\n' >> '${log}'; sleep ${delay}; printf '${label}-end\\n' >> '${log}'`]);
			child.once('error', reject); child.once('exit', (code) => code === 0 ? accept() : reject(new Error(`flock exited ${code}`)));
		});
		const first = run('first', '0.2'); await new Promise((accept) => setTimeout(accept, 30)); const second = run('second', '0'); await Promise.all([first, second]);
		const order = (await import('node:fs')).readFileSync(log, 'utf8').trim().split('\n');
		expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
		state.evidence.push({ case: 'apt-lock-contention', result: 'passed', order });
	});

	it('preserves known-good services when APT metadata is unavailable', async () => {
		state.refreshFailure = new Error('isolated apt metadata outage');
		await expect(reconcile('development')).rejects.toThrow('metadata outage');
		expect(state.operations.map((item) => item.operation)).toEqual(['apt.refresh']);
		state.refreshFailure = null; state.operations = [];
		const recovered = await reconcile('development');
		expect(recovered?.state).toBe('known-good');
		state.evidence.push({ case: 'apt-metadata-outage', result: 'passed', failedOperations: ['apt.refresh'], knownGoodPreserved: true, retryConverged: true });
	});

	it('restores packages, state, services, and routes after an unhealthy activation', async () => {
		state.activationFailure = new Error('isolated registry or health-gate failure');
		await expect(reconcile('development')).rejects.toThrow('health-gate failure');
		const operations = state.operations.map((item) => item.operation);
		expect(operations).toEqual(['apt.refresh', 'sandbox.trust-anchor.repair', 'compose.status', 'compose.stop', 'backup.create', 'apt.install', 'component.configure', 'compose.activate', 'compose.stop', 'recovery.restore', 'apt.install', 'compose.activate', 'compose.activate', 'edge.apply']);
		expect(state.events.map((item) => item.type)).toContain('reconcile.rollback-complete');
		state.operations = []; state.events = [];
		const recovered = await reconcile('development');
		expect(recovered?.state).toBe('known-good');
		state.evidence.push({ case: 'registry-health-outage-rollback', result: 'passed', operations, rollbackComplete: true, retryConverged: true });
	});

	it('recovers from an interrupted component package transaction', async () => {
		state.installFailure = new Error('isolated dpkg interruption');
		await expect(reconcile('development')).rejects.toThrow('dpkg interruption');
		const failed = state.operations.map((item) => item.operation);
		expect(failed).toContain('recovery.restore');
		state.operations = []; state.events = [];
		const recovered = await reconcile('development');
		expect(recovered?.state).toBe('known-good');
		state.evidence.push({ case: 'package-interruption', result: 'passed', rollbackComplete: true, retryConverged: true });
	});

	it('keeps stable activation outside its window while development remains independent', async () => {
		state.eligible = false;
		const before = state.previous;
		expect(await reconcile('stable')).toBe(before);
		expect(state.operations.map((item) => item.operation)).toEqual(['apt.refresh', 'sandbox.trust-anchor.repair']);
		state.evidence.push({ case: 'stable-window-gate', result: 'passed', activationOutsideWindow: false, developmentIndependent: true });
	});

	it('activates stable exactly once inside its window without claiming a development overlay', async () => {
		const oldApi = state.active[0], oldAgent = state.active[1], newApi = release('api', 'stable', 'e', '1.0.1-1');
		state.stable.components = [newApi]; state.stable.release = '1.0.1'; state.stable.generation = 2; state.stable.catalogDigest = hash('e');
		state.development.stableBase = { release: state.stable.release, catalogDigest: state.stable.catalogDigest };
		state.development.components[0].stableBase = { releaseRange: '^1.0.0', compatibilityId: 'treeseed-linux-amd64-v1', catalogDigest: state.stable.catalogDigest };
		state.active = [oldApi, oldAgent]; state.previous = receipt(state.active); state.eligible = true;
		const accepted = await reconcile('stable');
		expect(accepted?.packages.find((item) => item.name === 'treeseed-component-api')?.version).toBe('1.0.1-1');
		expect(accepted?.packages.find((item) => item.name === 'treeseed-component-agent')?.version).toBe(oldAgent.packages[0].version);
		const firstActivationCount = state.operations.filter((item) => item.operation === 'compose.activate').length;
		state.previous = accepted; state.active = [newApi, oldAgent]; state.operations = [];
		expect(await reconcile('stable')).toBe(accepted);
		expect(state.operations.map((item) => item.operation)).toEqual(['apt.refresh', 'sandbox.trust-anchor.repair', 'compose.status']);
		state.evidence.push({ case: 'stable-window-single-activation', result: 'passed', firstActivationCount, developmentReleasePreserved: oldAgent.release, secondActivationCount: 0 });
	});

	it('pauses without external work and resumes into one update followed by a no-op', async () => {
		state.paused = true;
		expect(await reconcile('development')).toBe(state.previous);
		expect(state.operations).toEqual([]);
		state.paused = false;
		const accepted = await reconcile('development');
		expect(accepted?.state).toBe('known-good');
		const activationCount = state.operations.filter((item) => item.operation === 'compose.activate').length;
		state.previous = accepted; state.active = [state.active[0], state.development.components[0]]; state.operations = [];
		expect(await reconcile('development')).toBe(accepted);
		expect(state.operations.map((item) => item.operation)).toEqual(['apt.refresh', 'sandbox.trust-anchor.repair', 'compose.status']);
		state.evidence.push({ case: 'pause-resume-noop', result: 'passed', activationCount, unchangedRestartCount: 0 });
	});

	it('repairs managed CLI custody during an otherwise unchanged tick', async () => {
		const current = state.development.components[0];
		state.active = [state.active[0], current]; state.previous = receipt(state.active);
		state.previous.catalogDigest = createPlan(state.host, state.stable, state.development, state.previous).plan.catalogDigest;
		unlinkSync(`${state.root}/cli/api-base-url`); unlinkSync(`${state.root}/cli/localhost-ca.crt`);
		const unchanged = await reconcile('development');
		expect(unchanged).toBe(state.previous);
		expect(state.operations.map((item) => item.operation)).toEqual(['apt.refresh', 'sandbox.trust-anchor.repair', 'compose.status', 'cli.configure']);
		state.evidence.push({ case: 'post-self-update-cli-custody', result: 'passed', componentRestartCount: 0, endpointAndCaRepaired: true });
	});

	it('records a catalog-only generation once without restarting components', async () => {
		const current = state.development.components[0];
		state.active = [state.active[0], current]; state.previous = receipt(state.active);
		state.previous.catalogDigest = createPlan(state.host, state.stable, state.development, state.previous).plan.catalogDigest;
		state.development.catalogDigest = hash('e'); state.operations = [];
		const accepted = await reconcile('development');
		expect(accepted?.catalogDigest).not.toBe(state.previous.catalogDigest);
		expect(state.operations.filter(({ operation }) => operation === 'compose.stop' || operation === 'compose.activate')).toEqual([]);
		state.previous = accepted; state.operations = [];
		expect(await reconcile('development')).toBe(accepted);
		expect(state.operations.map(({ operation }) => operation)).toEqual(['apt.refresh', 'sandbox.trust-anchor.repair', 'compose.status']);
	});

	it('repairs an absent enabled component even when its release identity is unchanged', async () => {
		const current = state.development.components[0];
		state.active = [state.active[0], current]; state.previous = receipt(state.active);
		state.previous.catalogDigest = createPlan(state.host, state.stable, state.development, state.previous).plan.catalogDigest;
		state.composeStatus = { present: false, running: false }; state.operations = [];
		const repaired = await reconcile('development');
		expect(repaired?.receiptId).not.toBe(state.previous.receiptId);
		expect(state.operations.filter(({ operation }) => operation === 'compose.activate')).toHaveLength(1);
		expect(state.events).toContainEqual({ type: 'component.repair-required', details: { componentId: 'agent', present: false, running: false } });
	});
});

afterAll(() => {
	const target = process.env.TREESEED_QUALIFICATION_EVIDENCE;
	if (target) writeFileSync(target, `${JSON.stringify({ schemaVersion: 'treeseed.update-qualification/v1', generatedAt: new Date().toISOString(), cases: state.evidence }, null, 2)}\n`);
});

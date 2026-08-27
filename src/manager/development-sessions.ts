import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { connect, type LookupFunction } from 'node:net';
import {
	developmentCandidateSchema, developmentRuntimeSchema, developmentSessionSchema, type DevelopmentCandidate, type DevelopmentRuntime,
	type DevelopmentSession, type DevelopmentTarget,
} from '@treeseed/sdk/development';
import { atomicJson } from '../core/files.js';
import { paths } from '../core/paths.js';
import type { EdgeRoute } from '../edge/caddy.js';

export interface ManagedDevelopmentSession {
	session: DevelopmentSession;
	runtimes: DevelopmentRuntime[];
	routes: Array<EdgeRoute & { projectId: string; targetId: string }>;
	candidates: DevelopmentCandidate[];
}

export interface DevelopmentSessionDependencies {
	now: () => Date;
	directHealth: (target: DevelopmentTarget, port: number) => Promise<boolean>;
	routedHealth: (alias: string, path: string) => Promise<boolean>;
}

const defaultNow = () => new Date();

async function defaultDirectHealth(target: DevelopmentTarget, port: number) {
	if (target.ready.kind === 'process') return true;
	if (target.ready.kind === 'tcp') {
		const timeoutSeconds = target.ready.timeoutSeconds;
		return new Promise<boolean>((resolveResult) => {
		const socket = connect({ host: '127.0.0.1', port });
		socket.setTimeout(timeoutSeconds * 1_000);
		socket.once('connect', () => { socket.destroy(); resolveResult(true); });
		socket.once('timeout', () => { socket.destroy(); resolveResult(false); });
		socket.once('error', () => resolveResult(false));
		});
	}
	if (target.ready.kind !== 'http') return false;
	try {
		const response = await fetch(`http://127.0.0.1:${port}${target.ready.path}`, { signal: AbortSignal.timeout(target.ready.timeoutSeconds * 1_000) });
		return response.status === target.ready.expectedStatus;
	} catch { return false; }
}

export const loopbackLookup: LookupFunction = (_hostname, options, callback) => {
	const address = { address: '127.0.0.1', family: 4 };
	if (options.all) callback(null, [address]);
	else callback(null, address.address, address.family);
};

async function routedHealthAttempt(alias: string, path: string) {
	return new Promise<boolean>((resolveResult) => {
		const request = httpsRequest({ hostname: alias, servername: alias, port: 443, path, method: 'GET', ca: readFileSync(`${paths.tls}/ca.crt`), lookup: loopbackLookup, timeout: 2_000 }, (response) => {
			response.resume(); resolveResult(Boolean(response.statusCode && response.statusCode < 500));
		});
		request.once('timeout', () => { request.destroy(); resolveResult(false); });
		request.once('error', () => resolveResult(false)); request.end();
	});
}

export async function boundedRoutedHealth(check: () => Promise<boolean>, timeoutMs = 30_000, retryMs = 250) {
	const deadline = Date.now() + timeoutMs;
	do {
		if (await check()) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(retryMs, Math.max(0, deadline - Date.now()))));
	} while (Date.now() <= deadline);
	return false;
}

function defaultRoutedHealth(alias: string, path: string) {
	return boundedRoutedHealth(() => routedHealthAttempt(alias, path));
}

function targetKey(projectId: string, targetId: string) { return `${projectId}.${targetId}`; }

function developmentEdgeHost(target: DevelopmentTarget) {
	const declared = target.operations.start?.environment.TREESEED_DEVELOPMENT_EDGE_HOST;
	if (declared === undefined) return 'host.docker.internal';
	if (!/^[a-z][a-z0-9-]{0,62}$/u.test(declared)) throw new Error('Development edge host must be a private container DNS identity.');
	return declared;
}
function recordPath(root: string, sessionId: string) { return `${root}/${sessionId}.json`; }

function validateRecord(value: unknown): ManagedDevelopmentSession {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Development session record must be an object.');
	const input = value as Record<string, unknown>;
	const session = developmentSessionSchema.parse(input.session);
	if (!Array.isArray(input.runtimes) || !Array.isArray(input.routes)) throw new Error('Development session runtimes and routes must be arrays.');
	const runtimes = input.runtimes.map((runtime) => developmentRuntimeSchema.parse(runtime));
	const routes = input.routes.map((route) => {
		if (!route || typeof route !== 'object' || Array.isArray(route)) throw new Error('Development route must be an object.');
		const entry = route as Record<string, unknown>;
		if (typeof entry.alias !== 'string' || typeof entry.upstream !== 'string' || typeof entry.projectId !== 'string' || typeof entry.targetId !== 'string') throw new Error('Development route is incomplete.');
		if (!['none', 'application', 'mtls'].includes(String(entry.authentication))) throw new Error('Development route authentication is invalid.');
		return entry as unknown as ManagedDevelopmentSession['routes'][number];
	});
	const candidates = Array.isArray(input.candidates) ? input.candidates.map((candidate) => developmentCandidateSchema.parse(candidate)) : [];
	return { session, runtimes, routes, candidates };
}

export class DevelopmentSessionStore {
	readonly #root: string;
	readonly #deps: DevelopmentSessionDependencies;

	constructor(root: string = paths.developmentSessions, dependencies: Partial<DevelopmentSessionDependencies> = {}) {
		this.#root = root;
		this.#deps = { now: dependencies.now ?? defaultNow, directHealth: dependencies.directHealth ?? defaultDirectHealth, routedHealth: dependencies.routedHealth ?? defaultRoutedHealth };
	}

	list(includeStopped = false) {
		if (!existsSync(this.#root)) return [];
		return readdirSync(this.#root).filter((name) => name.endsWith('.json')).map((name) => validateRecord(JSON.parse(readFileSync(`${this.#root}/${name}`, 'utf8'))))
			.filter((record) => includeStopped || !['stopped', 'expired'].includes(record.session.status))
			.sort((left, right) => left.session.createdAt.localeCompare(right.session.createdAt));
	}

	load(sessionId: string) {
		const path = recordPath(this.#root, sessionId);
		if (!existsSync(path)) throw new Error(`Unknown development session ${sessionId}.`);
		return validateRecord(JSON.parse(readFileSync(path, 'utf8')));
	}

	save(record: ManagedDevelopmentSession) {
		mkdirSync(this.#root, { recursive: true, mode: 0o700 });
		atomicJson(recordPath(this.#root, record.session.sessionId), record, 0o600);
		return record;
	}

	start(sessionInput: unknown, runtimeInputs: unknown[]) {
		const session = developmentSessionSchema.parse(sessionInput);
		const runtimes = runtimeInputs.map((runtime) => developmentRuntimeSchema.parse(runtime));
		if (this.list(true).some((record) => record.session.sessionId === session.sessionId)) throw new Error(`Development session ${session.sessionId} already exists.`);
		if (new Date(session.expiresAt) <= this.#deps.now()) throw new Error('Development session lease must expire in the future.');
		const runtimeByProject = new Map(runtimes.map((runtime) => [runtime.project.id, runtime]));
		for (const selected of session.targets) {
			const target = runtimeByProject.get(selected.projectId)?.targets.find((entry) => entry.id === selected.targetId);
			if (!target) throw new Error(`Unknown selected development target ${targetKey(selected.projectId, selected.targetId)}.`);
			if (selected.mode === 'live' && target.kind === 'rebuild-restart') throw new Error(`${targetKey(selected.projectId, selected.targetId)} must use candidate mode.`);
		}
		const requested = new Set(session.leases.map((lease) => `${lease.kind}:${lease.resource}`));
		for (const active of this.list()) for (const lease of active.session.leases) if (requested.has(`${lease.kind}:${lease.resource}`)) throw new Error(`Development lease conflict for ${lease.resource}.`);
		return this.save({ session: { ...session, status: 'active' }, runtimes, routes: [], candidates: [] });
	}

	setMode(sessionId: string, projectId: string, targetId: string, mode: DevelopmentSession['targets'][number]['mode']) {
		const record = this.load(sessionId);
		const target = record.session.targets.find((entry) => entry.projectId === projectId && entry.targetId === targetId);
		const contract = record.runtimes.find((runtime) => runtime.project.id === projectId)?.targets.find((entry) => entry.id === targetId);
		if (!target) throw new Error(`Target ${targetKey(projectId, targetId)} is outside session ${sessionId}.`);
		if (!contract) throw new Error(`Target contract ${targetKey(projectId, targetId)} is unavailable.`);
		const resources = [`component:${targetKey(projectId, targetId)}`, ...contract.endpoints.filter((endpoint) => endpoint.canonicalAlias).map((endpoint) => `alias:${endpoint.canonicalAlias}`)];
		if (mode === 'released') {
			record.routes = record.routes.filter((route) => targetKey(route.projectId, route.targetId) !== targetKey(projectId, targetId));
			record.session.leases = record.session.leases.filter((lease) => !resources.includes(`${lease.kind}:${lease.resource}`));
		} else {
			for (const active of this.list()) {
				if (active.session.sessionId === sessionId) continue;
				for (const lease of active.session.leases) if (resources.includes(`${lease.kind}:${lease.resource}`)) throw new Error(`Development lease conflict for ${lease.resource}.`);
			}
			for (const resource of resources) if (!record.session.leases.some((lease) => `${lease.kind}:${lease.resource}` === resource)) {
				const [kind, ...parts] = resource.split(':');
				record.session.leases.push({ kind: kind as 'alias' | 'component', resource: parts.join(':'), acquiredAt: this.#deps.now().toISOString(), expiresAt: record.session.expiresAt });
			}
		}
		target.mode = mode; target.health = mode === 'released' ? 'ready' : 'pending';
		return this.save(record);
	}

	async attach(sessionId: string, projectId: string, targetId: string, port: number) {
		const record = this.load(sessionId);
		const selected = record.session.targets.find((entry) => entry.projectId === projectId && entry.targetId === targetId);
		const target = record.runtimes.find((runtime) => runtime.project.id === projectId)?.targets.find((entry) => entry.id === targetId);
		if (!selected || !target || selected.mode === 'released') throw new Error(`Target ${targetKey(projectId, targetId)} is not selected for a development overlay.`);
		if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Development endpoint port is invalid.');
		if (!await this.#deps.directHealth(target, port)) throw new Error(`Direct readiness failed for ${targetKey(projectId, targetId)}.`);
		record.routes = record.routes.filter((route) => targetKey(route.projectId, route.targetId) !== targetKey(projectId, targetId));
		const edgeHost = developmentEdgeHost(target);
		for (const endpoint of target.endpoints.filter((entry) => entry.visibility === 'host')) record.routes.push({ alias: endpoint.canonicalAlias!, upstream: `${endpoint.protocol === 'https' ? 'https' : 'http'}://${edgeHost}:${port}`, authentication: endpoint.authentication, projectId, targetId });
		selected.health = 'ready'; selected.generation += 1;
		return this.save(record);
	}

	markReady(sessionId: string, projectId: string, targetId: string) {
		const record = this.load(sessionId);
		const selected = record.session.targets.find((entry) => entry.projectId === projectId && entry.targetId === targetId);
		if (!selected || selected.mode === 'released') throw new Error(`Target ${targetKey(projectId, targetId)} is not selected for a completed development generation.`);
		selected.health = 'ready'; selected.generation += 1;
		return this.save(record);
	}

	registerCandidate(sessionId: string, candidateInput: unknown) {
		const record = this.load(sessionId), candidate = developmentCandidateSchema.parse(candidateInput);
		if (candidate.sessionId !== sessionId) throw new Error('Development candidate belongs to a different session.');
		record.candidates = record.candidates.filter((entry) => entry.candidateId !== candidate.candidateId); record.candidates.push(candidate);
		return this.save(record);
	}

	async verifyRouted(sessionId: string, projectId: string, targetId: string) {
		const record = this.load(sessionId);
		const target = record.runtimes.find((runtime) => runtime.project.id === projectId)?.targets.find((entry) => entry.id === targetId);
		if (!target) throw new Error(`Unknown development target ${targetKey(projectId, targetId)}.`);
		for (const route of record.routes.filter((entry) => targetKey(entry.projectId, entry.targetId) === targetKey(projectId, targetId))) {
			if (!await this.#deps.routedHealth(route.alias, target.ready.kind === 'http' ? target.ready.path : '/')) {
				const selected = record.session.targets.find((entry) => entry.projectId === projectId && entry.targetId === targetId)!;
				selected.health = 'degraded'; record.session.status = 'degraded'; this.save(record); return false;
			}
		}
		return true;
	}

	stop(sessionId: string, expired = false) {
		const record = this.load(sessionId);
		record.routes = []; record.session.leases = []; record.session.status = expired ? 'expired' : 'stopped';
		for (const target of record.session.targets) target.health = 'stopped';
		return this.save(record);
	}

	expire() {
		const now = this.#deps.now();
		return this.list().filter((record) => new Date(record.session.expiresAt) <= now).map((record) => this.stop(record.session.sessionId, true));
	}

	activeRoutes(base: readonly EdgeRoute[]) {
		this.expire();
		const routes = new Map(base.map((route) => [route.alias, route]));
		for (const record of this.list()) for (const route of record.routes) routes.set(route.alias, { alias: route.alias, upstream: route.upstream, authentication: route.authentication });
		return [...routes.values()].sort((left, right) => left.alias.localeCompare(right.alias));
	}
}

export function affectedDevelopmentClosure(runtimeInputs: unknown[], selectedKeys: string[]) {
	const runtimes = runtimeInputs.map((runtime) => developmentRuntimeSchema.parse(runtime));
	const targets = new Map(runtimes.flatMap((runtime) => runtime.targets.map((target) => [targetKey(runtime.project.id, target.id), { projectId: runtime.project.id, target }] as const)));
	const affected = new Map<string, { key: string; reaction: string }>();
	const queue = selectedKeys.map((key) => ({ key, reaction: 'none' }));
	while (queue.length) {
		const current = queue.shift()!;
		if (affected.has(current.key)) continue;
		if (!targets.has(current.key)) throw new Error(`Unknown development target ${current.key}.`);
		affected.set(current.key, current);
		for (const [consumerKey, consumer] of targets) for (const dependency of consumer.target.dependencies) if (targetKey(dependency.id, dependency.target) === current.key && dependency.reaction !== 'none') queue.push({ key: consumerKey, reaction: dependency.reaction });
	}
	return [...affected.values()];
}

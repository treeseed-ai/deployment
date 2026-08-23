import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { hostReceiptSchema, type HostConfiguration, type HostReceipt } from '@treeseed/sdk/deployment';
import { z } from 'zod';
import { loadCatalog } from '../catalog/load.js';
import { loadHostConfiguration } from '../core/configuration.js';
import { recentEvents } from '../core/events.js';
import { paths } from '../core/paths.js';
import { requestSupervisor } from '../supervisor/client.js';
import type { ClientEnrollment } from '../supervisor/pki.js';
import { createPlan } from './plan.js';
import { reconcile, refreshAvailableCatalogs } from './reconcile.js';
import { loadUpdateState, updatePaused } from './update-state.js';

export const hostCommandRequestSchema = z.object({
	handlerId: z.string().regex(/^local\.host(?:\.[a-z]+)+$/u),
	arguments: z.array(z.string().max(256)).max(16).default([]),
	options: z.record(z.union([z.string().max(4_096), z.boolean(), z.array(z.string().max(4_096)).max(32)])).default({}),
}).strict();

export type HostCommandRequest = z.infer<typeof hostCommandRequestSchema>;

function receipt(): HostReceipt | null {
	const file = `${paths.managerState}/current-receipt.json`;
	return existsSync(file) ? hostReceiptSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) : null;
}

function plan() {
	const host = loadHostConfiguration(), stable = loadCatalog(`${paths.catalogs}/stable.json`), developmentPath = `${paths.catalogs}/development.json`;
	return createPlan(host, stable, existsSync(developmentPath) ? loadCatalog(developmentPath) : undefined, receipt() ?? undefined);
}

async function replaceConfiguration(mutate: (host: HostConfiguration) => HostConfiguration) {
	const current = loadHostConfiguration();
	const candidate = mutate(structuredClone(current));
	candidate.generation = current.generation + 1;
	await requestSupervisor({ operation: 'configuration.replace', configuration: candidate });
	return reconcile();
}

function componentId(request: HostCommandRequest) {
	const value = request.arguments[0];
	if (!value || !/^[a-z][a-z0-9.-]{1,63}$/u.test(value)) throw new Error('A valid component identity is required.');
	return value;
}

function bootstrapStatus() {
	const complete = existsSync('/var/lib/treeseed/bootstrap/handoff.complete');
	return { complete, configurationInstalled: existsSync(paths.configuration), managerTlsReady: existsSync(`${paths.tls}/ca.crt`), installerCredentialsRetained: existsSync('/var/lib/treeseed/bootstrap/seed/credentials.json') };
}

export async function executeHostCommand(input: unknown, context: { local: boolean }) {
	const request = hostCommandRequestSchema.parse(input), host = loadHostConfiguration();
	switch (request.handlerId) {
		case 'local.host.status': return { configurationId: host.configurationId, generation: host.generation, components: host.components, receipt: receipt(), updates: loadUpdateState() };
		case 'local.host.doctor': {
			const checks = [
				{ id: 'configuration', ok: existsSync(paths.configuration) },
				{ id: 'stable-catalog', ok: existsSync(`${paths.catalogs}/stable.json`) },
				{ id: 'supervisor', ok: existsSync(paths.socket) },
				{ id: 'manager-ca', ok: existsSync(`${paths.tls}/ca.crt`) },
			];
			try { plan(); } catch { checks.push({ id: 'accepted-plan', ok: false }); }
			if (!checks.some((check) => check.id === 'accepted-plan')) checks.push({ id: 'accepted-plan', ok: true });
			return { healthy: checks.every((check) => check.ok), checks };
		}
		case 'local.host.plan': return plan();
		case 'local.host.apply':
		case 'local.host.reconcile': return request.options.plan === true ? plan() : reconcile();
		case 'local.host.events': return { events: recentEvents(100) };
		case 'local.host.update.status': return { policy: host.updates, state: loadUpdateState(), receipt: receipt() };
		case 'local.host.update.check': {
			await refreshAvailableCatalogs(host, undefined, false);
			const stable = loadCatalog(`${paths.catalogs}/stable.json`), developmentPath = `${paths.catalogs}/development.json`;
			return { stable: { release: stable.release, generation: stable.generation, digest: stable.catalogDigest }, development: existsSync(developmentPath) ? (() => { const value = loadCatalog(developmentPath); return { release: value.release, generation: value.generation, digest: value.catalogDigest }; })() : null };
		}
		case 'local.host.update.apply': return request.options.plan === true ? plan() : reconcile();
		case 'local.host.update.channel': {
			const track = request.arguments[0];
			if (track !== 'stable' && track !== 'development') throw new Error('Update channel must be stable or development.');
			if (request.options.plan === true) return { track, mutation: false, nextGeneration: host.generation + 1 };
			return replaceConfiguration((candidate) => { candidate.updates.defaultTrack = track; return candidate; });
		}
		case 'local.host.update.pause':
		case 'local.host.update.resume': {
			const track = request.options.track;
			const selected = track === 'development' ? 'development' : 'stable';
			if (request.options.plan === true) return { track: selected, paused: request.handlerId.endsWith('.pause'), mutation: false };
			return updatePaused(selected, request.handlerId.endsWith('.pause'));
		}
		case 'local.host.component.list': return { components: host.components };
		case 'local.host.component.status': {
			const id = componentId(request); return { componentId: id, selection: host.components[id] ?? null, receipt: receipt() };
		}
		case 'local.host.component.enable':
		case 'local.host.component.disable': {
			const id = componentId(request), enabled = request.handlerId.endsWith('.enable');
			if (!host.components[id]) throw new Error(`Unknown configured component ${id}.`);
			return request.options.plan === true ? { componentId: id, enabled, nextGeneration: host.generation + 1 } : replaceConfiguration((candidate) => { candidate.components[id]!.enabled = enabled; return candidate; });
		}
		case 'local.host.aliases.list': return { aliases: plan().routes.map(({ alias, upstream, authentication }) => ({ alias, upstream, authentication })) };
		case 'local.host.recovery.status': return { current: receipt(), receipts: existsSync(paths.receipts) ? readdirSync(paths.receipts).filter((name) => name.endsWith('.json')).sort().slice(-20) : [] };
		case 'local.host.recovery.retry': return request.options.plan === true ? plan() : reconcile();
		case 'local.host.recovery.restore': {
			const generation = Number(request.arguments[0]);
			if (!Number.isInteger(generation) || generation < 1) throw new Error('A positive recovery generation is required.');
			if (request.options.plan === true) return { generation, mutation: false };
			await requestSupervisor({ operation: 'recovery.restore', generation }); return { generation, restored: true };
		}
		case 'local.host.bootstrap.status': return bootstrapStatus();
		case 'local.host.bootstrap.enroll': {
			if (!context.local) throw new Error('Client enrollment is available only through the protected local manager socket.');
			if (request.options.plan === true) return { action: 'enroll', mutation: false };
			const clientId = `client-${randomUUID().toLowerCase()}`;
			return requestSupervisor<ClientEnrollment>({ operation: 'pki.enroll', clientId });
		}
		default: throw new Error(`Unsupported host command ${request.handlerId}.`);
	}
}

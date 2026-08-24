import { existsSync, readFileSync } from 'node:fs';
import { componentReleaseSchema, hostReceiptSchema, type ComponentRelease, type HostConfiguration, type HostReceipt } from '@treeseed/sdk/deployment';
import { loadCatalog } from '../catalog/load.js';
import { loadHostConfiguration } from '../core/configuration.js';
import { atomicJson } from '../core/files.js';
import { recordEvent } from '../core/events.js';
import { paths } from '../core/paths.js';
import { edgeRoutes, renderCaddyfile, subjectAlternativeNames } from '../edge/caddy.js';
import { createPlan } from './plan.js';
import { activationEligible } from './update-policy.js';
import { validateProductionCompose } from '../runtime/compose.js';
import { requestSupervisor } from '../supervisor/client.js';
import { trackPaused } from './update-state.js';

function previousReceipt(): HostReceipt | undefined {
	const path = `${paths.managerState}/current-receipt.json`;
	return existsSync(path) ? hostReceiptSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) : undefined;
}

function previousComponents(): ComponentRelease[] {
	const path = `${paths.managerState}/active-components.json`;
	if (!existsSync(path)) return [];
	const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
	if (!Array.isArray(value)) throw new Error('Active component state is malformed.');
	return value.map((component) => componentReleaseSchema.parse(component));
}

interface AptRefreshResult { coreUpdated: boolean; before: Record<string, string | null>; after: Record<string, string | null> }

function configuredAptSource(track: 'stable' | 'development') {
	return `/etc/apt/sources.list.d/treeseed-deployment-${track}.sources`;
}

export async function refreshAvailableCatalogs(host: HostConfiguration, requestedTrack?: 'stable' | 'development', allowCoreUpdate = true) {
	const tracks = requestedTrack ? [requestedTrack] : [...new Set([host.updates.defaultTrack, ...Object.values(host.components).filter((component) => component.enabled).map((component) => component.track)])];
	let coreUpdated = false;
	const previousCore = new Map<string, string>();
	for (const track of tracks) {
		if (!existsSync(configuredAptSource(track))) {
			recordEvent('update.source-unconfigured', { track });
			continue;
		}
		const updateCore = allowCoreUpdate && track === host.updates.defaultTrack && activationEligible(host, track);
		const result = await requestSupervisor<AptRefreshResult>({ operation: 'apt.refresh', track, updateCore });
		coreUpdated ||= result.coreUpdated;
		for (const [name, version] of Object.entries(result.before)) if (version) previousCore.set(name, version);
		recordEvent('update.metadata-refreshed', { track, updateCore, coreUpdated: result.coreUpdated });
	}
	return { coreUpdated, previousCore };
}

function composeFiles(component: ComponentRelease) {
	return component.runtime.compose.files.map((file) => `${component.componentId}/${component.release}/${file}`);
}

async function stop(component: ComponentRelease) {
	await requestSupervisor({ operation: 'compose.stop', componentId: component.componentId, projectName: component.runtime.compose.projectName, files: composeFiles(component) });
}

async function activate(component: ComponentRelease) {
	const waitTimeoutSeconds = Math.max(60, ...component.runtime.services.flatMap((service) => service.endpoints.map((endpoint) => endpoint.healthGate?.timeoutSeconds ?? 0)));
	await requestSupervisor({ operation: 'component.configure', componentId: component.componentId });
	await requestSupervisor({ operation: 'compose.activate', componentId: component.componentId, projectName: component.runtime.compose.projectName, files: composeFiles(component), waitTimeoutSeconds });
}

export function rollbackRoutes(host: HostConfiguration, components: ComponentRelease[]) {
	const activeIds = new Set(components.map((component) => component.componentId));
	const overrides = Object.fromEntries(Object.entries(host.components).filter(([componentId]) => activeIds.has(componentId)).flatMap(([, component]) => Object.entries(component.aliases)));
	const routes = edgeRoutes(components, overrides);
	for (const alias of host.network.manager.aliases) routes.push({ alias, upstream: 'unix//run/treeseed/manager/api.sock', authentication: 'mtls' as const });
	return routes.sort((left, right) => left.alias.localeCompare(right.alias));
}

export async function reconcile(track?: 'stable' | 'development') {
	const host = loadHostConfiguration();
	const previous = previousReceipt();
	if (track && trackPaused(track)) {
		recordEvent('update.paused', { track });
		return previous;
	}
	const refresh = await refreshAvailableCatalogs(host, track);
	const stable = loadCatalog(`${paths.catalogs}/stable.json`);
	const developmentPath = `${paths.catalogs}/development.json`;
	const accepted = createPlan(host, stable, existsSync(developmentPath) ? loadCatalog(developmentPath) : undefined, previous);
	if (accepted.plan.blockers.length) throw new Error(`Host plan is blocked: ${accepted.plan.blockers.map((item) => item.code).join(', ')}`);
	if (track === 'stable' && previous && !activationEligible(host, 'stable')) {
		recordEvent('update.metadata-current', { track, eligible: false, catalogDigest: stable.catalogDigest });
		return previous;
	}
	const targets = previous && track ? accepted.components.filter((component) => host.components[component.componentId]?.track === track) : accepted.components;
	const active = previousComponents(), selectedIds = new Set(accepted.components.map((component) => component.componentId));
	const removed = active.filter((component) => !selectedIds.has(component.componentId));
	const changedIds = new Set(accepted.plan.changes.filter((change) => change.action !== 'noop').map((change) => change.componentId));
	const changed = targets.filter((component) => changedIds.has(component.componentId));
	const configurationChanged = previous?.configurationDigest !== accepted.plan.configurationDigest;
	if (changed.length === 0 && removed.length === 0 && !configurationChanged && previous) {
		recordEvent('reconcile.noop', { track: track ?? 'all', receiptId: previous.receiptId });
		if (refresh.coreUpdated) await requestSupervisor({ operation: 'manager.restart' });
		return previous;
	}
	const packages = changed.flatMap((component) => component.packages).sort((left, right) => left.order - right.order).map((item) => `${item.name}=${item.version}`);
	const impacted = configurationChanged ? active : active.filter((component) => changedIds.has(component.componentId) || !selectedIds.has(component.componentId));
	const generation = Date.now();
	for (const component of impacted) await stop(component);
	await requestSupervisor({ operation: 'backup.create', generation });
	try {
		if (packages.length) await requestSupervisor({ operation: 'apt.install', packages });
		for (const component of accepted.components) validateProductionCompose(component, `${paths.bundles}/${component.componentId}/${component.release}`);
		for (const component of configurationChanged ? accepted.components : changed) await activate(component);
		await requestSupervisor({ operation: 'edge.apply', caddyfile: renderCaddyfile(accepted.routes), aliases: subjectAlternativeNames(accepted.routes) });
	} catch (error) {
		recordEvent('reconcile.rollback-started', { generation, message: error instanceof Error ? error.message : String(error) });
		for (const component of changed) {
			try { await stop(component); } catch { /* continue restoring the last known-good generation */ }
		}
		const rollbackPackages = [...refresh.previousCore.entries(), ...active.flatMap((component) => component.packages.map((item) => [item.name, item.version] as const))].map(([name, version]) => `${name}=${version}`);
		if (rollbackPackages.length) await requestSupervisor({ operation: 'apt.install', packages: [...new Set(rollbackPackages)] });
		await requestSupervisor({ operation: 'recovery.restore', generation });
		for (const component of active) await activate(component);
		const previousRoutes = rollbackRoutes(host, active);
		await requestSupervisor({ operation: 'edge.apply', caddyfile: renderCaddyfile(previousRoutes), aliases: subjectAlternativeNames(previousRoutes) });
		recordEvent('reconcile.rollback-complete', { generation, receiptId: previous?.receiptId ?? null });
		throw error;
	}
	const receipt = hostReceiptSchema.parse({ schemaVersion: 'treeseed.host-receipt/v1', receiptId: `receipt-${Date.now()}`, planId: accepted.plan.planId, state: 'known-good', configurationDigest: accepted.plan.configurationDigest, catalogDigest: accepted.plan.catalogDigest, packages: accepted.components.flatMap((component) => component.packages), images: accepted.components.flatMap((component) => component.images), completedAt: new Date().toISOString() });
	atomicJson(`${paths.receipts}/${receipt.receiptId}.json`, receipt);
	atomicJson(`${paths.managerState}/current-receipt.json`, receipt);
	atomicJson(`${paths.managerState}/active-components.json`, accepted.components);
	recordEvent('reconcile.complete', { receiptId: receipt.receiptId, planId: receipt.planId });
	if (refresh.coreUpdated) await requestSupervisor({ operation: 'manager.restart' });
	return receipt;
}

import { existsSync, readFileSync } from 'node:fs';
import { componentReleaseSchema, hostReceiptSchema, type ComponentRelease, type HostConfiguration, type HostReceipt } from '@treeseed/sdk/deployment';
import { loadCatalog } from '../catalog/load.js';
import { loadHostConfiguration } from '../core/configuration.js';
import { atomicJson } from '../core/files.js';
import { recordEvent } from '../core/events.js';
import { paths } from '../core/paths.js';
import { edgeRoutes, renderCaddyfile, subjectAlternativeNames } from '../edge/caddy.js';
import { createPlan } from './plan.js';
import { activationEligible, metadataRefreshDue } from './update-policy.js';
import { validateProductionCompose } from '../runtime/compose.js';
import { requestSupervisor } from '../supervisor/client.js';
import { loadUpdateState, metadataChecked, trackPaused } from './update-state.js';

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

export async function refreshAvailableCatalogs(host: HostConfiguration, requestedTrack?: 'stable' | 'development', allowCoreUpdate = true, forceMetadata = false) {
	const tracks = requestedTrack ? [requestedTrack] : [...new Set([host.updates.defaultTrack, ...Object.values(host.components).filter((component) => component.enabled).map((component) => component.track)])];
	let coreUpdated = false;
	const previousCore = new Map<string, string>();
	for (const track of tracks) {
		if (!forceMetadata && !metadataRefreshDue(host, track, loadUpdateState())) {
			recordEvent('update.metadata-not-due', { track });
			continue;
		}
		if (!existsSync(configuredAptSource(track))) {
			recordEvent('update.source-unconfigured', { track });
			continue;
		}
		const updateCore = allowCoreUpdate && track === host.updates.defaultTrack && activationEligible(host, track);
		const result = await requestSupervisor<AptRefreshResult>({ operation: 'apt.refresh', track, updateCore });
		metadataChecked(track);
		coreUpdated ||= result.coreUpdated;
		for (const [name, version] of Object.entries(result.before)) if (version) previousCore.set(name, version);
		recordEvent('update.metadata-refreshed', { track, updateCore, coreUpdated: result.coreUpdated });
	}
	return { coreUpdated, previousCore };
}

function composeFiles(component: ComponentRelease) {
	return component.runtime.compose.files.map((file) => `${component.componentId}/${component.release}/${file.path}`);
}

function managedConnectionEnvironment(host: HostConfiguration, component: ComponentRelease, releases: ComponentRelease[]) {
	const selection = host.components[component.componentId]!, selected = new Map(releases.map((release) => [release.componentId, release]));
	const values: Record<string, string> = {};
	for (const dependency of component.runtime.dependencies) {
		const connection = selection.connections[dependency.id];
		if (!connection) continue;
		const prefix = `TREESEED_${dependency.id.replaceAll('-', '_').toUpperCase()}`;
		if (connection.kind === 'remote') {
			values[`${prefix}_URL`] = connection.url.replace(/\/$/u, '');
			values[`${prefix}_AUDIENCE`] = connection.audience;
			if (connection.tls.caSecretRef) values[`${prefix}_CA_FILE`] = host.secrets[connection.tls.caSecretRef]!.reference;
			if (connection.authentication.secretRef) values[`${prefix}_CREDENTIAL_FILE`] = host.secrets[connection.authentication.secretRef]!.reference;
			continue;
		}
		const target = selected.get(connection.componentId)!, service = target.runtime.services.find((candidate) => candidate.id === connection.serviceId)!;
		const endpoint = service.endpoints.find((candidate) => candidate.id === connection.endpointId)!;
		values[`${prefix}_URL`] = `${endpoint.protocol}://${service.composeService}:${endpoint.port}`;
		const identity = `${target.componentId}.${service.id}.${endpoint.id}`;
		const alias = host.components[target.componentId]?.aliases[identity] ?? endpoint.defaultAlias;
		values[`${prefix}_AUDIENCE`] = alias ? `https://${alias}` : values[`${prefix}_URL`]!;
	}
	return values;
}

function record(value: unknown, label: string) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
	return value as Record<string, unknown>;
}

async function enrollProvider(host: HostConfiguration, component: ComponentRelease) {
	if (component.componentId !== 'agent') return;
	const configuration = record(host.components.agent?.configuration, 'Agent configuration');
	if (configuration.providerEnrollment === undefined) return;
	const enrollment = record(configuration.providerEnrollment, 'Provider enrollment');
	const connection = host.components.agent?.connections['control-plane'];
	if (!connection || connection.kind !== 'remote') throw new Error('Provider enrollment requires an explicit remote control-plane connection.');
	const connectionId = enrollment.connectionId, teamId = enrollment.teamId, offer = record(enrollment.offer, 'Provider enrollment offer');
	if (typeof connectionId !== 'string' || typeof teamId !== 'string' || typeof offer.maxConcurrentRunners !== 'number' || !Array.isArray(offer.capabilities) || !offer.capabilities.every((item) => typeof item === 'string')) throw new Error('Provider enrollment configuration is invalid.');
	const registrationSecretId = connection.authentication.secretRef;
	if (!registrationSecretId) throw new Error('Provider enrollment requires a one-time registration secret reference.');
	await requestSupervisor({ operation: 'provider.enroll', connectionId, teamId, controlPlaneUrl: connection.url, controlPlaneAudience: connection.audience, registrationSecretId, offer: { maxConcurrentRunners: offer.maxConcurrentRunners, capabilities: offer.capabilities, metadata: { hostId: host.host.id, role: host.host.role, rolloutGroup: host.fleet.rolloutGroup } }, files: composeFiles(component), projectName: 'treeseed-agent' });
}

async function stop(component: ComponentRelease) {
	await requestSupervisor({ operation: 'compose.stop', componentId: component.componentId, projectName: component.runtime.compose.projectName, files: composeFiles(component) });
}

async function activate(host: HostConfiguration, component: ComponentRelease, releases: ComponentRelease[]) {
	const waitTimeoutSeconds = Math.max(60, ...component.runtime.services.flatMap((service) => service.endpoints.map((endpoint) => endpoint.healthGate?.timeoutSeconds ?? 0)));
	await requestSupervisor({ operation: 'component.configure', componentId: component.componentId, connectionEnvironment: managedConnectionEnvironment(host, component, releases) });
	await requestSupervisor({ operation: 'compose.activate', componentId: component.componentId, projectName: component.runtime.compose.projectName, files: composeFiles(component), waitTimeoutSeconds });
}

export function rollbackRoutes(host: HostConfiguration, components: ComponentRelease[]) {
	const activeIds = new Set(components.map((component) => component.componentId));
	const overrides = Object.fromEntries(Object.entries(host.components).filter(([componentId]) => activeIds.has(componentId)).flatMap(([, component]) => Object.entries(component.aliases)));
	const routes = edgeRoutes(components, overrides);
	for (const alias of host.network.manager.aliases) routes.push({ alias, upstream: 'unix//run/treeseed/manager/api.sock', authentication: 'mtls' as const });
	return routes.sort((left, right) => left.alias.localeCompare(right.alias));
}

export async function withDeferredManagerRestart<T>(coreUpdated: boolean, operation: () => Promise<T>, scheduleRestart: () => Promise<unknown> = () => requestSupervisor({ operation: 'manager.restart' })) {
	try { return await operation(); }
	finally {
		if (coreUpdated) {
			try { await scheduleRestart(); }
			catch (error) {
				try { recordEvent('manager.restart-schedule-failed', { message: error instanceof Error ? error.message : String(error) }); }
				catch { /* preserve the reconciliation result when restart scheduling cannot be recorded */ }
			}
		}
	}
}

export async function reconcile(track?: 'stable' | 'development') {
	const host = loadHostConfiguration();
	const previous = previousReceipt();
	if (track && trackPaused(track)) {
		recordEvent('update.paused', { track });
		return previous;
	}
	const refresh = await refreshAvailableCatalogs(host, track);
	return withDeferredManagerRestart(refresh.coreUpdated, async () => {
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
		return previous;
	}
	const packages = changed.flatMap((component) => component.packages).sort((left, right) => left.order - right.order).map((item) => `${item.name}=${item.version}`);
	if (accepted.routes.length) packages.unshift('treeseed-edge');
	const impacted = configurationChanged ? active : active.filter((component) => changedIds.has(component.componentId) || !selectedIds.has(component.componentId));
	const generation = Date.now();
	for (const component of impacted) await stop(component);
	await requestSupervisor({ operation: 'backup.create', generation });
	try {
		if (packages.length) await requestSupervisor({ operation: 'apt.install', packages });
		for (const component of accepted.components) validateProductionCompose(component, `${paths.bundles}/${component.componentId}/${component.release}`);
		for (const component of configurationChanged ? accepted.components : changed) await activate(host, component, accepted.components);
		for (const component of configurationChanged ? accepted.components : changed) await enrollProvider(host, component);
		if (accepted.routes.length) await requestSupervisor({ operation: 'edge.apply', caddyfile: renderCaddyfile(accepted.routes), aliases: subjectAlternativeNames(accepted.routes) });
	} catch (error) {
		recordEvent('reconcile.rollback-started', { generation, message: error instanceof Error ? error.message : String(error) });
		for (const component of changed) {
			try { await stop(component); } catch { /* continue restoring the last known-good generation */ }
		}
		const rollbackPackages = [...refresh.previousCore.entries(), ...active.flatMap((component) => component.packages.map((item) => [item.name, item.version] as const))].map(([name, version]) => `${name}=${version}`);
		if (rollbackPackages.length) await requestSupervisor({ operation: 'apt.install', packages: [...new Set(rollbackPackages)] });
		await requestSupervisor({ operation: 'recovery.restore', generation });
		for (const component of active) await activate(host, component, active);
		const previousRoutes = rollbackRoutes(host, active);
		if (previousRoutes.length) await requestSupervisor({ operation: 'edge.apply', caddyfile: renderCaddyfile(previousRoutes), aliases: subjectAlternativeNames(previousRoutes) });
		recordEvent('reconcile.rollback-complete', { generation, receiptId: previous?.receiptId ?? null });
		throw error;
	}
	const receipt = hostReceiptSchema.parse({ schemaVersion: 'treeseed.host-receipt/v1', receiptId: `receipt-${Date.now()}`, planId: accepted.plan.planId, state: 'known-good', hostId: host.host.id, role: host.host.role, rolloutGroup: host.fleet.rolloutGroup, configurationDigest: accepted.plan.configurationDigest, catalogDigest: accepted.plan.catalogDigest, packages: accepted.components.flatMap((component) => component.packages), images: accepted.components.flatMap((component) => component.images), runtimes: accepted.components.map((component) => ({ componentId: component.componentId, release: component.release, runtimeDigest: component.runtimeDigest })), completedAt: new Date().toISOString() });
	atomicJson(`${paths.receipts}/${receipt.receiptId}.json`, receipt);
	atomicJson(`${paths.managerState}/current-receipt.json`, receipt);
	atomicJson(`${paths.managerState}/active-components.json`, accepted.components);
	recordEvent('reconcile.complete', { receiptId: receipt.receiptId, planId: receipt.planId });
	return receipt;
	});
}

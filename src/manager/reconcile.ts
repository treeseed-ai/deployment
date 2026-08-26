import { existsSync, readFileSync } from 'node:fs';
import { hostReceiptSchema, type ComponentRelease, type HostConfiguration, type HostReceipt } from '@treeseed/sdk/deployment';
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
import { loadActiveComponents, loadCurrentReceipt } from './current-state.js';
import { DevelopmentSessionStore } from './development-sessions.js';

interface AptRefreshResult { coreUpdated: boolean; before: Record<string, string | null>; after: Record<string, string | null> }

function configuredAptSource(track: 'stable' | 'development') {
	return `/etc/apt/sources.list.d/treeseed-deployment-${track}.sources`;
}

export function aptSuiteForRefresh(hostDefaultTrack: 'stable' | 'development', requestedTrack: 'stable' | 'development') {
	return hostDefaultTrack === 'development' || requestedTrack === 'development' ? 'development' : 'stable';
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
		const suite = aptSuiteForRefresh(host.updates.defaultTrack, track);
		if (!existsSync(configuredAptSource(suite))) {
			recordEvent('update.source-unconfigured', { track, suite });
			continue;
		}
		const updateCore = allowCoreUpdate && track === host.updates.defaultTrack && activationEligible(host, track);
		const result = await requestSupervisor<AptRefreshResult>({ operation: 'apt.refresh', track: suite, updateCore });
		metadataChecked(track);
		coreUpdated ||= result.coreUpdated;
		for (const [name, version] of Object.entries(result.before)) if (version) previousCore.set(name, version);
		recordEvent('update.metadata-refreshed', { track, suite, updateCore, coreUpdated: result.coreUpdated });
	}
	return { coreUpdated, previousCore };
}

export function composeFiles(component: ComponentRelease) {
	return component.runtime.compose.files.map((file) => `${component.componentId}/${component.release}/${file.path}`);
}

export function managedConnectionEnvironment(host: HostConfiguration, component: ComponentRelease, releases: ComponentRelease[]) {
	const selection = host.components[component.componentId]!, selected = new Map(releases.map((release) => [release.componentId, release]));
	const values: Record<string, string> = {};
	if (component.componentId === 'agent') {
		values.TREESEED_PROVIDER_ENVIRONMENT = selection.connections['control-plane']?.kind === 'local' ? 'local' : 'managed';
	}
	for (const dependency of component.runtime.dependencies) {
		const connection = selection.connections[dependency.id];
		if (!connection) continue;
		const prefix = `TREESEED_${dependency.id.replaceAll('-', '_').toUpperCase()}`;
		if (connection.kind === 'remote') {
			values[`${prefix}_URL`] = connection.url.replace(/\/$/u, '');
			if (component.componentId === 'admin' && dependency.id === 'api') values.TREESEED_API_BASE_URL = values[`${prefix}_URL`]!;
			values[`${prefix}_AUDIENCE`] = connection.audience;
			if (connection.tls.caSecretRef) values[`${prefix}_CA_FILE`] = host.secrets[connection.tls.caSecretRef]!.reference;
			if (connection.authentication.secretRef) values[`${prefix}_CREDENTIAL_FILE`] = host.secrets[connection.authentication.secretRef]!.reference;
			continue;
		}
		const target = selected.get(connection.componentId)!, service = target.runtime.services.find((candidate) => candidate.id === connection.serviceId)!;
		const endpoint = service.endpoints.find((candidate) => candidate.id === connection.endpointId)!;
		values[`${prefix}_URL`] = `${endpoint.protocol}://${service.composeService}:${endpoint.port}`;
		if (component.componentId === 'admin' && dependency.id === 'api') values.TREESEED_API_BASE_URL = values[`${prefix}_URL`]!;
		const identity = `${target.componentId}.${service.id}.${endpoint.id}`;
		const alias = host.components[target.componentId]?.aliases[identity] ?? endpoint.defaultAlias;
		values[`${prefix}_AUDIENCE`] = alias ? `https://${alias}` : values[`${prefix}_URL`]!;
	}
	return values;
}

export function managedDevelopmentConnectionEnvironment(host: HostConfiguration, component: ComponentRelease, releases: ComponentRelease[]) {
	const values = managedConnectionEnvironment(host, component, releases), selection = host.components[component.componentId], selected = new Map(releases.map((release) => [release.componentId, release]));
	for (const dependency of component.runtime.dependencies) {
		const connection = selection?.connections[dependency.id]; if (!connection || connection.kind !== 'local') continue;
		const target = selected.get(connection.componentId), service = target?.runtime.services.find((candidate) => candidate.id === connection.serviceId), endpoint = service?.endpoints.find((candidate) => candidate.id === connection.endpointId);
		if (!target || !service || !endpoint) continue;
		const identity = `${target.componentId}.${service.id}.${endpoint.id}`, alias = host.components[target.componentId]?.aliases[identity] ?? endpoint.defaultAlias;
		if (!alias) continue;
		const prefix = `TREESEED_${dependency.id.replaceAll('-', '_').toUpperCase()}`, url = `https://${alias}`;
		values[`${prefix}_URL`] = url; values[`${prefix}_AUDIENCE`] = url;
		if (component.componentId === 'admin' && dependency.id === 'api') values.TREESEED_API_BASE_URL = url;
		values.NODE_EXTRA_CA_CERTS = '/etc/treeseed/cli/localhost-ca.crt';
	}
	return values;
}

export function managedCliControlPlaneUrl(host: HostConfiguration, releases: ComponentRelease[]) {
	const api = releases.find((component) => component.componentId === 'api');
	if (api) {
		for (const service of api.runtime.services) for (const endpoint of service.endpoints) {
			if (endpoint.visibility !== 'host') continue;
			const identity = `api.${service.id}.${endpoint.id}`;
			const alias = host.components.api?.aliases[identity] ?? endpoint.defaultAlias;
			if (alias) return `https://${alias}`;
		}
	}
	const remote = host.components.agent?.connections['control-plane'];
	return remote?.kind === 'remote' ? remote.url.replace(/\/$/u, '') : undefined;
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
	const previous = loadCurrentReceipt();
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
	const active = loadActiveComponents(), activeById = new Map(active.map((component) => [component.componentId, component]));
	const effective = previous && track ? accepted.components.map((component) => host.components[component.componentId]?.track === track ? component : activeById.get(component.componentId) ?? component) : accepted.components;
	const developmentSessions = new DevelopmentSessionStore();
	const expiredDevelopmentSessions = developmentSessions.expire();
	const routes = developmentSessions.activeRoutes(rollbackRoutes(host, effective));
	const targets = previous && track ? effective.filter((component) => host.components[component.componentId]?.track === track) : effective;
	const selectedIds = new Set(effective.map((component) => component.componentId));
	const removed = active.filter((component) => !selectedIds.has(component.componentId));
	const changedIds = new Set(accepted.plan.changes.filter((change) => change.action !== 'noop').map((change) => change.componentId));
	const changed = targets.filter((component) => changedIds.has(component.componentId));
	const changedTargetIds = new Set(changed.map((component) => component.componentId));
	const configurationChanged = previous?.configurationDigest !== accepted.plan.configurationDigest;
	const cliControlPlaneUrl = managedCliControlPlaneUrl(host, effective);
	const cliUrlPath = `${paths.cli}/api-base-url`, cliCaPath = `${paths.cli}/localhost-ca.crt`;
	const cliConfigurationChanged = cliControlPlaneUrl !== undefined && (!existsSync(cliUrlPath) || readFileSync(cliUrlPath, 'utf8').trim() !== cliControlPlaneUrl || !existsSync(cliCaPath));
	if (cliConfigurationChanged) await requestSupervisor({ operation: 'cli.configure', controlPlaneUrl: cliControlPlaneUrl });
	if (changed.length === 0 && removed.length === 0 && !configurationChanged && !refresh.coreUpdated && expiredDevelopmentSessions.length === 0 && previous) {
		recordEvent('reconcile.noop', { track: track ?? 'all', receiptId: previous.receiptId });
		return previous;
	}
	if (changed.length === 0 && removed.length === 0 && !configurationChanged && !refresh.coreUpdated && expiredDevelopmentSessions.length > 0 && previous) {
		if (routes.length) await requestSupervisor({ operation: 'edge.apply', caddyfile: renderCaddyfile(routes), aliases: subjectAlternativeNames(routes) });
		recordEvent('development.sessions-expired', { sessions: expiredDevelopmentSessions.map((record) => record.session.sessionId) });
		return previous;
	}
	const packages = changed.flatMap((component) => component.packages).sort((left, right) => left.order - right.order).map((item) => `${item.name}=${item.version}`);
	if (routes.length) packages.unshift(`treeseed-edge/${host.updates.defaultTrack}`);
	const impacted = configurationChanged ? active : active.filter((component) => changedTargetIds.has(component.componentId) || !selectedIds.has(component.componentId));
	const generation = Date.now();
	for (const component of impacted) await stop(component);
	await requestSupervisor({ operation: 'backup.create', generation });
	try {
		if (packages.length) await requestSupervisor({ operation: 'apt.install', packages });
		for (const component of effective) validateProductionCompose(component, `${paths.bundles}/${component.componentId}/${component.release}`);
		for (const component of configurationChanged ? effective : changed) await activate(host, component, effective);
		for (const component of configurationChanged ? effective : changed) await enrollProvider(host, component);
		if (routes.length) await requestSupervisor({ operation: 'edge.apply', caddyfile: renderCaddyfile(routes), aliases: subjectAlternativeNames(routes) });
	} catch (error) {
		recordEvent('reconcile.rollback-started', { generation, message: error instanceof Error ? error.message : String(error) });
		for (const component of changed) {
			try { await stop(component); } catch { /* continue restoring the last known-good generation */ }
		}
		const rollbackPackages = [...refresh.previousCore.entries(), ...active.flatMap((component) => component.packages.map((item) => [item.name, item.version] as const))].map(([name, version]) => `${name}=${version}`);
		if (rollbackPackages.length) await requestSupervisor({ operation: 'apt.install', packages: [...new Set(rollbackPackages)] });
		await requestSupervisor({ operation: 'recovery.restore', generation });
		for (const component of active) await activate(host, component, active);
		const previousRoutes = developmentSessions.activeRoutes(rollbackRoutes(host, active));
		if (previousRoutes.length) await requestSupervisor({ operation: 'edge.apply', caddyfile: renderCaddyfile(previousRoutes), aliases: subjectAlternativeNames(previousRoutes) });
		recordEvent('reconcile.rollback-complete', { generation, receiptId: previous?.receiptId ?? null });
		throw error;
	}
	const receipt = hostReceiptSchema.parse({ schemaVersion: 'treeseed.host-receipt/v1', receiptId: `receipt-${Date.now()}`, planId: accepted.plan.planId, state: 'known-good', hostId: host.host.id, role: host.host.role, rolloutGroup: host.fleet.rolloutGroup, configurationDigest: accepted.plan.configurationDigest, catalogDigest: accepted.plan.catalogDigest, packages: effective.flatMap((component) => component.packages), images: effective.flatMap((component) => component.images), runtimes: effective.map((component) => ({ componentId: component.componentId, release: component.release, runtimeDigest: component.runtimeDigest })), completedAt: new Date().toISOString() });
	atomicJson(`${paths.receipts}/${receipt.receiptId}.json`, receipt);
	atomicJson(`${paths.managerState}/current-receipt.json`, receipt);
	atomicJson(`${paths.managerState}/active-components.json`, effective);
	recordEvent('reconcile.complete', { receiptId: receipt.receiptId, planId: receipt.planId });
	return receipt;
	});
}

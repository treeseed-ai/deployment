import { existsSync, readFileSync } from 'node:fs';
import { hostReceiptSchema, type ComponentRelease, type HostConfiguration, type HostReceipt } from '@treeseed/sdk/deployment';
import { loadCatalog } from '../catalog/load.js';
import { loadHostConfiguration } from '../core/configuration.js';
import { atomicJson } from '../core/files.js';
import { recordEvent } from '../core/events.js';
import { paths } from '../core/paths.js';
import { edgeRoutes, renderCaddyfile, subjectAlternativeNames, type EdgeRoute } from '../edge/caddy.js';
import { edgeReadiness } from '../edge/readiness.js';
import { createPlan } from './plan.js';
import { activationEligible, metadataRefreshDue } from './update-policy.js';
import { validateProductionCompose } from '../runtime/compose.js';
import { requestSupervisor } from '../supervisor/client.js';
import { loadUpdateState, metadataChecked, recoverDevelopmentPauseOwners, trackPaused } from './update-state.js';
import { loadActiveComponents, loadCurrentReceipt } from './current-state.js';
import { DevelopmentSessionStore } from './development-sessions.js';
import { managedRuntimeInputEnvironment } from './runtime-inputs.js';
import { aiModeActivationServices, reconcileAiModeSelection } from './ai-mode.js';
import { reconcileFailurePolicy, requireAutomaticRollback } from './serialized-reconcile.js';
import { quiescedBackup } from './quiesced-backup.js';
import { componentActivationOrder, componentStopOrder } from './component-order.js';
import { readConnectionDigest, recordConnectionDigest, reconcilePeerConnections } from './development-peer-connections.js';

interface AptRefreshResult { coreUpdated: boolean; before: Record<string, string | null>; after: Record<string, string | null> }

export interface HostSecurityActivationStatus {
	backingExists: boolean;
	mapperOpen: boolean;
	mounted: boolean;
	credentialKeksReady: boolean;
	recoveryBundleVerified: boolean;
	sandboxSocketReady: boolean;
}

export function hostSecurityActivationBlockers(
	required: boolean,
	status: HostSecurityActivationStatus,
) {
	if (!required) return [];
	return (Object.entries(status) as Array<[keyof HostSecurityActivationStatus, boolean]>)
		.filter(([, ready]) => !ready)
		.map(([name]) => name)
		.sort();
}

export function sandboxGuestTrustDigest(
	releasedDigest: string | undefined,
	heldByDevelopmentSession: boolean,
) {
	// A development session owns guest trust for its lifetime. Its candidate
	// import binds the exact local digest atomically; normal reconciliation must
	// neither pull the released image nor replace that binding mid-session.
	return heldByDevelopmentSession ? undefined : releasedDigest;
}

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
		const updateCore = allowCoreUpdate && track === host.updates.defaultTrack && (forceMetadata || activationEligible(host, track));
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
		if (dependency.id === 'treedx') {
			const environment = host.components[target.componentId]?.configuration?.environment as Record<string, unknown> | undefined;
			const nodeId = environment?.TREEDX_REMOTE_CREDENTIAL_BROKER_SERVICE_ID;
			if (typeof nodeId === 'string' && nodeId.trim()) {
				const configured = (selection.configuration?.environment as Record<string, unknown> | undefined)?.TREESEED_TREEDX_NODE_ID;
				if (configured !== undefined && configured !== nodeId.trim()) throw new Error('API TreeDX broker identity conflicts with its selected connection.');
				if (configured === undefined) values.TREESEED_TREEDX_NODE_ID = nodeId.trim();
			}
		}
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

export function managedContainerDevelopmentConnectionEnvironment(host: HostConfiguration, component: ComponentRelease, releases: ComponentRelease[], routes: readonly EdgeRoute[]) {
	const values = managedConnectionEnvironment(host, component, releases), selection = host.components[component.componentId], selected = new Map(releases.map((release) => [release.componentId, release]));
	// Selected development peers override released internal service names. This is
	// intentionally session-scoped and lets a containerized API reach a candidate
	// TreeDX (and similar peers) through its manager-owned loopback route.
	for (const route of routes) {
		if (!route.projectId) continue;
		const prefix = `TREESEED_${route.projectId.replaceAll('-', '_').toUpperCase()}`;
		values[`${prefix}_URL`] = route.upstream;
		if (route.projectId === 'treedx') {
			const hostname = new URL(route.upstream).hostname;
			values.TREESEED_LOCAL_TREEDX_HOSTS = [values.TREESEED_LOCAL_TREEDX_HOSTS, hostname]
				.filter((candidate): candidate is string => Boolean(candidate))
				.join(',');
		}
	}
	for (const dependency of component.runtime.dependencies) {
		const connection = selection?.connections[dependency.id]; if (!connection || connection.kind !== 'local') continue;
		const target = selected.get(connection.componentId), service = target?.runtime.services.find((candidate) => candidate.id === connection.serviceId), endpoint = service?.endpoints.find((candidate) => candidate.id === connection.endpointId);
		if (!target || !service || !endpoint) continue;
		const identity = `${target.componentId}.${service.id}.${endpoint.id}`, alias = host.components[target.componentId]?.aliases[identity] ?? endpoint.defaultAlias;
		const route = alias ? routes.find((candidate) => candidate.alias === alias) : undefined;
		if (!route) continue;
		const prefix = `TREESEED_${dependency.id.replaceAll('-', '_').toUpperCase()}`;
		values[`${prefix}_URL`] = route.upstream;
		if (component.componentId === 'admin' && dependency.id === 'api') values.TREESEED_API_BASE_URL = route.upstream;
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

export async function enrollProvider(host: HostConfiguration, component: ComponentRelease) {
	if (component.componentId !== 'agent') return;
	const configuration = record(host.components.agent?.configuration, 'Agent configuration');
	if (configuration.providerEnrollment === undefined) return;
	const enrollment = record(configuration.providerEnrollment, 'Provider enrollment');
	const connection = host.components.agent?.connections['control-plane'];
	if (!connection || connection.kind !== 'remote') throw new Error('Provider enrollment requires an explicit remote control-plane connection.');
	const connectionId = enrollment.connectionId, registrationSecretId = enrollment.registrationSecretId, offer = record(enrollment.offer, 'Provider enrollment offer');
	if (typeof connectionId !== 'string' || typeof registrationSecretId !== 'string' || typeof offer.maxConcurrentRunners !== 'number' || !Array.isArray(offer.capabilities) || !offer.capabilities.every((item) => typeof item === 'string')) throw new Error('Provider enrollment configuration is invalid.');
	await requestSupervisor({ operation: 'provider.enroll', connectionId, controlPlaneUrl: connection.url, controlPlaneAudience: connection.audience, registrationSecretId, offer: { maxConcurrentRunners: offer.maxConcurrentRunners, capabilities: offer.capabilities, metadata: { hostId: host.host.id, role: host.host.role, rolloutGroup: host.fleet.rolloutGroup } }, files: composeFiles(component), projectName: 'treeseed-agent' });
}

export async function stopComponent(component: ComponentRelease) {
	await requestSupervisor({ operation: 'compose.stop', componentId: component.componentId, projectName: component.runtime.compose.projectName, files: composeFiles(component) });
}

export function componentActivationInputs(host: HostConfiguration, component: ComponentRelease, releases: ComponentRelease[], developmentRoutes: readonly EdgeRoute[] = []) {
	const connectionEnvironment = host.runtime.environment === 'development'
		? managedContainerDevelopmentConnectionEnvironment(host, component, releases, developmentRoutes)
		: managedConnectionEnvironment(host, component, releases);
	if (component.runtime.modeControl?.role === 'controller') {
		const [, port] = host.network.manager.binding.split(':');
		Object.assign(connectionEnvironment, {
			TREESEED_AI_MODE_URL: `https://host.docker.internal:${port}/v1/ai/mode`,
			TREESEED_AI_MODE_CA_FILE: '/run/secrets/ai-mode-ca',
			TREESEED_AI_MODE_CERT_FILE: '/run/secrets/ai-mode-client-cert',
			TREESEED_AI_MODE_KEY_FILE: '/run/secrets/ai-mode-client-key',
		});
	}
	const runtimeEnvironment = managedRuntimeInputEnvironment(host, component, undefined, connectionEnvironment);
	const managerInputs = new Set(component.runtime.configuration.environment.filter(({ source }) => source === 'manager').map(({ name }) => name));
	const configuredEnvironment = (host.components[component.componentId]?.configuration?.environment ?? {}) as Record<string, string>;
	for (const [name, value] of Object.entries(runtimeEnvironment)) {
		const packageDefault = component.runtime.configuration.environment.some((declaration) =>
			declaration.name === name && declaration.source === 'configuration' && declaration.default !== undefined && configuredEnvironment[name] === undefined);
		if (!managerInputs.has(name) && !packageDefault) continue;
		if (connectionEnvironment[name] !== undefined) throw new Error(`Runtime input ${name} conflicts with a managed connection for ${component.componentId}.`);
		connectionEnvironment[name] = value;
	}
	const secretFileIds = component.runtime.configuration.secretFiles.filter(({ id }) => host.secrets[id] !== undefined).map(({ id }) => id);
	const optionalSecretEnvironment = component.runtime.configuration.secretEnvironment.filter(({ required }) => !required).map(({ name }) => name);
	return { connectionEnvironment, secretFileIds, optionalSecretEnvironment };
}

export async function activateComponent(host: HostConfiguration, component: ComponentRelease, releases: ComponentRelease[], backupGeneration?: number) {
	const waitTimeoutSeconds = Math.max(60, ...component.runtime.services.flatMap((service) => service.endpoints.map((endpoint) => endpoint.healthGate?.timeoutSeconds ?? 0)));
	const developmentRoutes = host.runtime.environment === 'development' ? new DevelopmentSessionStore().activeRoutes([]) : [];
	const { connectionEnvironment, secretFileIds, optionalSecretEnvironment } = componentActivationInputs(host, component, releases, developmentRoutes);
	if (component.runtime.modeControl?.role === 'controller') await requestSupervisor({ operation: 'ai.mode.credentials.ensure' });
	const sandboxGuestImageDigest = component.componentId === 'agent' ? component.images.find((image) => image.role === 'sandbox-guest')?.digest : undefined;
	await requestSupervisor({ operation: 'component.configure', componentId: component.componentId, release: component.release, connectionEnvironment, secretFileIds, optionalSecretEnvironment, ...(sandboxGuestImageDigest ? { sandboxGuestImageDigest } : {}) });
	if (component.runtime.postgresLifecycle?.length) {
		await requestSupervisor({ operation: 'postgres.component.activate', componentId: component.componentId,
			selections: releases.map(({ componentId, release }) => ({ componentId, release })), ...(backupGeneration ? { backupGeneration } : {}) });
	} else await requestSupervisor({ operation: 'compose.activate', componentId: component.componentId, projectName: component.runtime.compose.projectName, files: composeFiles(component), services: aiModeActivationServices(component), waitTimeoutSeconds });
	recordConnectionDigest(component.componentId, connectionEnvironment);
}

export async function reconcileDevelopmentPeers(host: HostConfiguration, releases: ComponentRelease[], store: DevelopmentSessionStore) {
	const routes = host.runtime.environment === 'development' ? store.activeRoutes([]) : [];
	const held = new Set(store.list().flatMap(({ session }) => session.targets.filter(({ mode }) => mode !== 'released').map(({ projectId }) => projectId)));
	const ordered = componentActivationOrder(host, releases);
	return reconcilePeerConnections(ordered.map(component => ({
		componentId: component.componentId,
		released: componentActivationInputs(host, component, releases).connectionEnvironment,
		desired: componentActivationInputs(host, component, releases, routes).connectionEnvironment,
	})), held, { read: readConnectionDigest, activate: id => activateComponent(host, ordered.find(component => component.componentId === id)!, releases) });
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

export async function withCoreUpgradeHandoff<T>(coreUpdated: boolean, previous: T, operation: () => Promise<T>, noteHandoff: () => void = () => recordEvent('manager.core-upgrade-handoff', {})) {
	if (!coreUpdated) return operation();
	noteHandoff();
	return previous;
}

export function runtimeRepairTargets<T extends { componentId: string }>(targets: T[], changedIds: ReadonlySet<string>, heldIds: ReadonlySet<string>, configurationChanged = false): T[] {
	// Candidate Compose files arrive during package installation. Already-planned
	// changes receive post-install activation checks, not pre-install drift probes.
	// Desired credential bindings have not been materialized yet. Inspecting them
	// as if they were the accepted runtime would reject legitimate configuration changes.
	return configurationChanged ? [] : targets.filter(({ componentId }) => !changedIds.has(componentId) && !heldIds.has(componentId));
}

export async function reconcile(track?: 'stable' | 'development', forceMetadata = false,
	configurationComponentScope: readonly string[] = [], failurePolicy: 'rollback' | 'halt' = 'rollback') {
	failurePolicy = reconcileFailurePolicy(failurePolicy);
	let host = loadHostConfiguration();
	const previous = loadCurrentReceipt();
	const configurationScope = new Set(configurationComponentScope);
	if (track && trackPaused(track)) {
		recordEvent('update.paused', { track });
		return previous;
	}
	if (host.runtime.environment === 'development') {
		const ensured = await requestSupervisor<{ changed: boolean; generation: number }>({ operation: 'development.configuration.ensure' });
		if (ensured.changed) {
			host = loadHostConfiguration();
			recordEvent('development.configuration-reconciled', { generation: ensured.generation, componentId: 'treedx' });
		}
	}
	const refresh = configurationScope.size
		? { coreUpdated: false, previousCore: new Map<string, string>() }
		: await refreshAvailableCatalogs(host, track, true, forceMetadata);
	return withDeferredManagerRestart(refresh.coreUpdated, () => withCoreUpgradeHandoff(refresh.coreUpdated, previous, async () => {
	if (host.security) {
		const security = await requestSupervisor<HostSecurityActivationStatus>({ operation: 'security.status' });
		const missing = hostSecurityActivationBlockers(true, security);
		if (missing.length) {
			recordEvent('security.activation-blocked', { missing });
			throw new Error('host_security_initialization_required');
		}
	}
	if (host.components.agent?.enabled) await requestSupervisor({ operation: 'sandbox.trust-anchor.repair' });
	const stable = loadCatalog(`${paths.catalogs}/stable.json`);
	const developmentPath = `${paths.catalogs}/development.json`;
	const accepted = createPlan(host, stable, existsSync(developmentPath) ? loadCatalog(developmentPath) : undefined, previous);
	if (accepted.plan.blockers.length) throw new Error(`Host plan is blocked: ${accepted.plan.blockers.map((item) => item.code).join(', ')}`);
	if (track === 'stable' && previous && !activationEligible(host, 'stable')) {
		recordEvent('update.metadata-current', { track, eligible: false, catalogDigest: stable.catalogDigest });
		return previous;
	}
	const developmentSessions = new DevelopmentSessionStore();
	const activeDevelopmentSessions = developmentSessions.list();
	// User-owned recovery must be scheduled even when an unrelated AI runtime fails.
	const bootRecovery = await Promise.allSettled(activeDevelopmentSessions.map(record => requestSupervisor<{ ready: boolean }>({ operation: 'development.boot.resume', sessionId: record.session.sessionId })));
	recoverDevelopmentPauseOwners(activeDevelopmentSessions.map((record) => record.session.sessionId));
	const heldDevelopmentComponents = new Set(activeDevelopmentSessions.flatMap((record) => record.session.targets.filter((target) => target.mode !== 'released').map((target) => target.projectId)));
	const active = loadActiveComponents(), activeById = new Map(active.map((component) => [component.componentId, component]));
	const effectiveCandidates = previous ? accepted.components.map((component) => {
		const heldBySession = heldDevelopmentComponents.has(component.componentId);
		const outsideRequestedTrack = Boolean(track && host.components[component.componentId]?.track !== track);
		return heldBySession || outsideRequestedTrack || configurationScope.size > 0
			? activeById.get(component.componentId) ?? component : component;
	}) : accepted.components;
	const effective = [...effectiveCandidates, ...active.filter((component) => heldDevelopmentComponents.has(component.componentId) && !effectiveCandidates.some((candidate) => candidate.componentId === component.componentId))];
	const routes = developmentSessions.activeRoutes(rollbackRoutes(host, effective));
	const targets = previous && track ? effective.filter((component) => host.components[component.componentId]?.track === track) : effective;
	const selectedIds = new Set(effective.map((component) => component.componentId));
	const removed = active.filter((component) => !selectedIds.has(component.componentId));
	const changedIds = configurationScope.size ? new Set<string>()
		: new Set(accepted.plan.changes.filter((change) => change.action !== 'noop').map((change) => change.componentId));
	const agent = effective.find((component) => component.componentId === 'agent');
	if (agent) await requestSupervisor({ operation: 'sandbox.model-policy.reconcile' });
	const hostDevelopment = agent && heldDevelopmentComponents.has('agent')
		? await requestSupervisor<{ status: string; guestImageDigest: string | null } | undefined>({ operation: 'host.development.status' })
		: undefined;
	const selectedGuestDigest = sandboxGuestTrustDigest(
		agent?.images.find((image) => image.role === 'sandbox-guest')?.digest,
		heldDevelopmentComponents.has('agent'),
	);
	const configuredGuestDigests = agent && selectedGuestDigest ? await requestSupervisor<string[]>({ operation: 'sandbox.guest-trust.digests' }) : [];
	if (agent && selectedGuestDigest && (configuredGuestDigests.length === 0 || configuredGuestDigests.some((digest) => digest !== selectedGuestDigest))) {
		await requestSupervisor({ operation: 'sandbox.guest-trust.bind', digest: selectedGuestDigest });
		recordEvent('sandbox.guest-trust-reconciled', { componentId: 'agent', previousDigests: configuredGuestDigests, selectedGuestDigest });
	}
	const configurationChanged = previous?.configurationDigest !== accepted.plan.configurationDigest;
	if (previous) {
		for (const component of runtimeRepairTargets(targets, changedIds, heldDevelopmentComponents, configurationChanged)) {
			const services = aiModeActivationServices(component) ?? component.runtime.services.map(({ composeService }) => composeService);
			const status = await requestSupervisor<{ present?: boolean; running?: boolean; ready?: boolean; issues?: Array<{ service: string; reason: string }> }>({ operation: 'compose.status', projectName: component.runtime.compose.projectName, runtime: { componentId: component.componentId, files: composeFiles(component), services } });
			if (status?.ready === false || typeof status?.present === 'boolean' && (!status.present || !status.running)) {
				changedIds.add(component.componentId);
				recordEvent('component.repair-required', { componentId: component.componentId, present: status.present === true, running: status.running === true, ...(status.issues?.length ? { issues: status.issues } : {}) });
			}
		}
	}
	const changed = targets.filter((component) => changedIds.has(component.componentId) && !heldDevelopmentComponents.has(component.componentId));
	const changedTargetIds = new Set(changed.map((component) => component.componentId));
	if (configurationChanged && configurationScope.size) {
		for (const componentId of configurationScope) {
			if (!effective.some((component) => component.componentId === componentId)) throw new Error(`Scoped component ${componentId} is unavailable.`);
			changedIds.add(componentId);
		}
	}
	const catalogChanged = previous?.catalogDigest !== accepted.plan.catalogDigest;
	const cliControlPlaneUrl = managedCliControlPlaneUrl(host, effective);
	const cliUrlPath = `${paths.cli}/api-base-url`, cliCaPath = `${paths.cli}/localhost-ca.crt`;
	const cliConfigurationChanged = cliControlPlaneUrl !== undefined && (!existsSync(cliUrlPath) || readFileSync(cliUrlPath, 'utf8').trim() !== cliControlPlaneUrl || !existsSync(cliCaPath));
	if (cliConfigurationChanged) await requestSupervisor({ operation: 'cli.configure', controlPlaneUrl: cliControlPlaneUrl });
	if (previous && changed.length === 0 && !configurationChanged && !catalogChanged && removed.length === 0) await reconcileDevelopmentPeers(host, effective, developmentSessions);
	if (changed.length === 0 && removed.length === 0 && !configurationChanged && !catalogChanged && !refresh.coreUpdated && previous) {
		if (routes.length && !await edgeReadiness(subjectAlternativeNames(routes))) {
			await requestSupervisor({ operation: 'edge.apply', caddyfile: renderCaddyfile(routes), aliases: subjectAlternativeNames(routes) });
			if (!await edgeReadiness(subjectAlternativeNames(routes))) throw new Error('Managed edge TLS readiness failed after repair.');
			recordEvent('edge.repaired', {});
		}
		await reconcileAiModeSelection(host, effective);
		if (bootRecovery.some(result => result.status === 'rejected' || !result.value.ready)) {
			recordEvent('development.boot-recovery-pending', {});
			return previous;
		}
		recordEvent('reconcile.noop', { track: track ?? 'all', receiptId: previous.receiptId });
		return previous;
	}
	const packages = changed.flatMap((component) => component.packages).sort((left, right) => left.order - right.order).map((item) => `${item.name}=${item.version}`);
	if (routes.length) packages.unshift(`treeseed-edge/${host.updates.defaultTrack}`);
	const configurationImpacts = (componentId: string) => configurationChanged
		&& (configurationScope.size === 0 || configurationScope.has(componentId));
	const snapshotRequired = Boolean(previous && (configurationChanged || removed.length || changed.some(component => component.release !== activeById.get(component.componentId)?.release || component.runtimeDigest !== activeById.get(component.componentId)?.runtimeDigest)));
	const impacted = (component: ComponentRelease) => snapshotRequired || configurationImpacts(component.componentId) || changedTargetIds.has(component.componentId) || !selectedIds.has(component.componentId);
	const activationOrder = componentActivationOrder(host, effective);
	const generation = Date.now();
	if (host.runtime.environment === 'development' && effective.some(({ componentId }) => componentId === 'api')) await requestSupervisor({ operation: 'development.credentials.ensure' });
	for (const component of activationOrder.filter((component) => configurationImpacts(component.componentId)
		|| changedTargetIds.has(component.componentId))) componentActivationInputs(host, component, effective);
	await quiescedBackup(componentStopOrder(host, active).filter(impacted), componentActivationOrder(host, active).filter(impacted), {
		stop: stopComponent, start: component => activateComponent(loadHostConfiguration(), component, active),
		rollbackConfiguration: async () => previous ? requestSupervisor({ operation: 'configuration.restore-accepted' }) : undefined,
		capture: async () => {
			if (!snapshotRequired) return;
			const backup = await requestSupervisor({ operation: 'backup.create', generation });
			recordEvent('backup.created', { generation });
			return backup;
		},
	});
	try {
		if (packages.length) await requestSupervisor({ operation: 'apt.install', packages });
		for (const component of effective) validateProductionCompose(component, `${paths.bundles}/${component.componentId}/${component.release}`);
		for (const component of activationOrder) {
			if (configurationImpacts(component.componentId) || changedTargetIds.has(component.componentId)) await activateComponent(host, component, effective, snapshotRequired ? generation : undefined);
			else if (snapshotRequired) await activateComponent(host, component, effective, generation);
		}
		await reconcileAiModeSelection(host, effective);
		for (const component of activationOrder.filter((component) => configurationImpacts(component.componentId)
			|| changedTargetIds.has(component.componentId))) await enrollProvider(host, component);
		if (routes.length) await requestSupervisor({ operation: 'edge.apply', caddyfile: renderCaddyfile(routes), aliases: subjectAlternativeNames(routes) });
		if (routes.length && !await edgeReadiness(subjectAlternativeNames(routes))) throw new Error('Managed edge TLS readiness failed after activation.');
	} catch (error) {
		recordEvent(failurePolicy === 'halt' ? 'reconcile.halted' : 'reconcile.rollback-started', { generation, message: error instanceof Error ? error.message : String(error) });
		for (const component of componentStopOrder(host, effective).filter(impacted)) {
			try { await stopComponent(component); } catch { /* continue restoring the last known-good generation */ }
		}
		requireAutomaticRollback(failurePolicy);
		if (snapshotRequired) await requestSupervisor({ operation: 'recovery.restore', generation });
		const rollbackPackages = [...refresh.previousCore.entries(), ...active.flatMap((component) => component.packages.map((item) => [item.name, item.version] as const))].map(([name, version]) => `${name}=${version}`);
		if (rollbackPackages.length) await requestSupervisor({ operation: 'apt.install', packages: [...new Set(rollbackPackages)] });
		try {
			const restoredHost = loadHostConfiguration();
			for (const component of componentActivationOrder(restoredHost, active)) await activateComponent(restoredHost, component, active);
			const previousRoutes = developmentSessions.activeRoutes(rollbackRoutes(host, active));
			if (previousRoutes.length) await requestSupervisor({ operation: 'edge.apply', caddyfile: renderCaddyfile(previousRoutes), aliases: subjectAlternativeNames(previousRoutes) });
			recordEvent('reconcile.rollback-complete', { generation, receiptId: previous?.receiptId ?? null });
		} catch (rollbackError) {
			const originalMessage = error instanceof Error ? error.message : String(error), rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
			recordEvent('reconcile.rollback-failed', { generation, message: rollbackMessage, originalMessage });
			throw new Error(`Reconciliation failed: ${originalMessage}; rollback also failed: ${rollbackMessage}`, { cause: error });
		}
		throw error;
	}
	const receipt = hostReceiptSchema.parse({ schemaVersion: 'treeseed.host-receipt/v1', receiptId: `receipt-${Date.now()}`, planId: accepted.plan.planId, state: 'known-good', hostId: host.host.id, role: host.host.role, rolloutGroup: host.fleet.rolloutGroup, configurationDigest: accepted.plan.configurationDigest, catalogDigest: configurationScope.size && previous ? previous.catalogDigest : accepted.plan.catalogDigest, packages: effective.flatMap((component) => component.packages), images: effective.flatMap((component) => component.images), runtimes: effective.map((component) => ({ componentId: component.componentId, release: component.release, runtimeDigest: component.runtimeDigest })), completedAt: new Date().toISOString() });
	atomicJson(`${paths.receipts}/${receipt.receiptId}.json`, receipt);
	atomicJson(`${paths.managerState}/current-receipt.json`, receipt);
	atomicJson(`${paths.managerState}/active-components.json`, effective);
	await requestSupervisor({ operation: 'updates.activate' });
	recordEvent('reconcile.complete', { receiptId: receipt.receiptId, planId: receipt.planId });
	return receipt;
	}, () => recordEvent('manager.core-upgrade-handoff', { track: track ?? 'all' })));
}

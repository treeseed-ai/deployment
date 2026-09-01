import { existsSync, readFileSync } from 'node:fs';
import { hostReceiptSchema, type ComponentRelease, type HostConfiguration, type HostReceipt } from '@treeseed/sdk/deployment';
import { loadCatalog } from '../catalog/load.js';
import { loadHostConfiguration } from '../core/configuration.js';
import { atomicJson } from '../core/files.js';
import { recordEvent } from '../core/events.js';
import { paths } from '../core/paths.js';
import { edgeRoutes, renderCaddyfile, subjectAlternativeNames, type EdgeRoute } from '../edge/caddy.js';
import { createPlan } from './plan.js';
import { activationEligible, metadataRefreshDue } from './update-policy.js';
import { validateProductionCompose } from '../runtime/compose.js';
import { requestSupervisor } from '../supervisor/client.js';
import { loadUpdateState, metadataChecked, noteDevelopmentPauseOwner, recoverDevelopmentPauseOwners, trackPaused } from './update-state.js';
import { loadActiveComponents, loadCurrentReceipt } from './current-state.js';
import { DevelopmentSessionStore } from './development-sessions.js';
import { managedRuntimeInputEnvironment } from './runtime-inputs.js';
import { aiModeActivationServices, reconcileAiModeSelection } from './ai-mode.js';

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

/**
 * Orders a composition so every locally connected dependency is healthy before
 * its consumers are activated. The input order remains the tie-breaker for
 * unrelated components, keeping reconciliation deterministic.
 */
export function componentActivationOrder(host: HostConfiguration, releases: ComponentRelease[]) {
	const selected = new Map(releases.map((release) => [release.componentId, release]));
	const indegree = new Map(releases.map((release) => [release.componentId, 0]));
	const consumers = new Map(releases.map((release) => [release.componentId, new Set<string>()]));
	for (const consumer of releases) {
		const selection = host.components[consumer.componentId];
		for (const dependency of consumer.runtime.dependencies) {
			const connection = selection?.connections[dependency.id];
			if (!connection || connection.kind !== 'local') continue;
			if (!selected.has(connection.componentId)) throw new Error(`Component ${consumer.componentId} requires unavailable local component ${connection.componentId}.`);
			const dependentIds = consumers.get(connection.componentId)!;
			if (dependentIds.has(consumer.componentId)) continue;
			dependentIds.add(consumer.componentId);
			indegree.set(consumer.componentId, indegree.get(consumer.componentId)! + 1);
		}
	}
	const pending = releases.filter((release) => indegree.get(release.componentId) === 0);
	const ordered: ComponentRelease[] = [];
	while (pending.length) {
		const dependency = pending.shift()!;
		ordered.push(dependency);
		for (const consumerId of consumers.get(dependency.componentId)!) {
			const remaining = indegree.get(consumerId)! - 1;
			indegree.set(consumerId, remaining);
			if (remaining === 0) pending.push(selected.get(consumerId)!);
		}
	}
	if (ordered.length !== releases.length) {
		const cycle = releases.filter((release) => !ordered.includes(release)).map((release) => release.componentId).join(', ');
		throw new Error(`Local component dependency cycle: ${cycle}.`);
	}
	return ordered;
}

export function componentStopOrder(host: HostConfiguration, releases: ComponentRelease[]) {
	return componentActivationOrder(host, releases).reverse();
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
	const connectionId = enrollment.connectionId, teamId = enrollment.teamId, offer = record(enrollment.offer, 'Provider enrollment offer');
	if (typeof connectionId !== 'string' || typeof teamId !== 'string' || typeof offer.maxConcurrentRunners !== 'number' || !Array.isArray(offer.capabilities) || !offer.capabilities.every((item) => typeof item === 'string')) throw new Error('Provider enrollment configuration is invalid.');
	const registrationSecretId = connection.authentication.secretRef;
	if (!registrationSecretId) throw new Error('Provider enrollment requires a one-time registration secret reference.');
	await requestSupervisor({ operation: 'provider.enroll', connectionId, teamId, controlPlaneUrl: connection.url, controlPlaneAudience: connection.audience, registrationSecretId, offer: { maxConcurrentRunners: offer.maxConcurrentRunners, capabilities: offer.capabilities, metadata: { hostId: host.host.id, role: host.host.role, rolloutGroup: host.fleet.rolloutGroup } }, files: composeFiles(component), projectName: 'treeseed-agent' });
}

export async function stopComponent(component: ComponentRelease) {
	await requestSupervisor({ operation: 'compose.stop', componentId: component.componentId, projectName: component.runtime.compose.projectName, files: composeFiles(component) });
}

export function componentActivationInputs(host: HostConfiguration, component: ComponentRelease, releases: ComponentRelease[]) {
	const connectionEnvironment = managedConnectionEnvironment(host, component, releases);
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
	for (const [name, value] of Object.entries(runtimeEnvironment)) {
		if (connectionEnvironment[name] !== undefined) throw new Error(`Runtime input ${name} conflicts with a managed connection for ${component.componentId}.`);
		if (managerInputs.has(name)) connectionEnvironment[name] = value;
	}
	const secretFileIds = component.runtime.configuration.secretFiles.filter(({ id }) => host.secrets[id] !== undefined).map(({ id }) => id);
	const optionalSecretEnvironment = component.runtime.configuration.secretEnvironment.filter(({ required }) => !required).map(({ name }) => name);
	return { connectionEnvironment, secretFileIds, optionalSecretEnvironment };
}

export async function activateComponent(host: HostConfiguration, component: ComponentRelease, releases: ComponentRelease[]) {
	const waitTimeoutSeconds = Math.max(60, ...component.runtime.services.flatMap((service) => service.endpoints.map((endpoint) => endpoint.healthGate?.timeoutSeconds ?? 0)));
	const { connectionEnvironment, secretFileIds, optionalSecretEnvironment } = componentActivationInputs(host, component, releases);
	if (component.runtime.modeControl?.role === 'controller') await requestSupervisor({ operation: 'ai.mode.credentials.ensure' });
	const sandboxGuestImageDigest = component.componentId === 'agent' ? component.images.find((image) => image.role === 'sandbox-guest')?.digest : undefined;
	await requestSupervisor({ operation: 'component.configure', componentId: component.componentId, connectionEnvironment, secretFileIds, optionalSecretEnvironment, ...(sandboxGuestImageDigest ? { sandboxGuestImageDigest } : {}) });
	await requestSupervisor({ operation: 'compose.activate', componentId: component.componentId, projectName: component.runtime.compose.projectName, files: composeFiles(component), services: aiModeActivationServices(component), waitTimeoutSeconds });
}

/** Reactivates configuration already restored from an encrypted generation backup. */
export async function activateRestoredComponent(component: ComponentRelease) {
	const waitTimeoutSeconds = Math.max(60, ...component.runtime.services.flatMap((service) => service.endpoints.map((endpoint) => endpoint.healthGate?.timeoutSeconds ?? 0)));
	await requestSupervisor({ operation: 'compose.activate', componentId: component.componentId, projectName: component.runtime.compose.projectName, files: composeFiles(component), services: aiModeActivationServices(component), waitTimeoutSeconds });
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

export async function reconcile(track?: 'stable' | 'development', forceMetadata = false,
	configurationComponentScope: readonly string[] = []) {
	const host = loadHostConfiguration();
	const previous = loadCurrentReceipt();
	const configurationScope = new Set(configurationComponentScope);
	if (track && trackPaused(track)) {
		recordEvent('update.paused', { track });
		return previous;
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
	const expiredDevelopmentSessions = developmentSessions.expire();
	for (const expired of expiredDevelopmentSessions) noteDevelopmentPauseOwner(expired.session.sessionId, false);
	const activeDevelopmentSessions = developmentSessions.list();
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
	if (previous) {
		for (const component of targets.filter((candidate) => !heldDevelopmentComponents.has(candidate.componentId))) {
			const status = await requestSupervisor<{ present?: boolean; running?: boolean }>({ operation: 'compose.status', projectName: component.runtime.compose.projectName });
			if (typeof status?.present === 'boolean' && (!status.present || !status.running)) {
				changedIds.add(component.componentId);
				recordEvent('component.repair-required', { componentId: component.componentId, present: status.present, running: status.running === true });
			}
		}
	}
	const changed = targets.filter((component) => changedIds.has(component.componentId) && !heldDevelopmentComponents.has(component.componentId));
	const changedTargetIds = new Set(changed.map((component) => component.componentId));
	const configurationChanged = previous?.configurationDigest !== accepted.plan.configurationDigest;
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
	if (changed.length === 0 && removed.length === 0 && !configurationChanged && !catalogChanged && !refresh.coreUpdated && expiredDevelopmentSessions.length === 0 && previous) {
		await reconcileAiModeSelection(host, effective);
		recordEvent('reconcile.noop', { track: track ?? 'all', receiptId: previous.receiptId });
		return previous;
	}
	if (changed.length === 0 && removed.length === 0 && !configurationChanged && !catalogChanged && !refresh.coreUpdated && expiredDevelopmentSessions.length > 0 && previous) {
		if (routes.length) await requestSupervisor({ operation: 'edge.apply', caddyfile: renderCaddyfile(routes), aliases: subjectAlternativeNames(routes) });
		recordEvent('development.sessions-expired', { sessions: expiredDevelopmentSessions.map((record) => record.session.sessionId) });
		return previous;
	}
	const packages = changed.flatMap((component) => component.packages).sort((left, right) => left.order - right.order).map((item) => `${item.name}=${item.version}`);
	if (routes.length) packages.unshift(`treeseed-edge/${host.updates.defaultTrack}`);
	const configurationImpacts = (componentId: string) => configurationChanged
		&& (configurationScope.size === 0 || configurationScope.has(componentId));
	const impacted = componentStopOrder(host, active).filter((component) => configurationImpacts(component.componentId)
		|| changedTargetIds.has(component.componentId) || !selectedIds.has(component.componentId));
	const activationOrder = componentActivationOrder(host, effective);
	const generation = Date.now();
	if (host.runtime.environment === 'development' && effective.some(({ componentId }) => componentId === 'api')) await requestSupervisor({ operation: 'development.credentials.ensure' });
	for (const component of activationOrder.filter((component) => configurationImpacts(component.componentId)
		|| changedTargetIds.has(component.componentId))) componentActivationInputs(host, component, effective);
	for (const component of impacted) await stopComponent(component);
	await requestSupervisor({ operation: 'backup.create', generation });
	try {
		if (packages.length) await requestSupervisor({ operation: 'apt.install', packages });
		for (const component of effective) validateProductionCompose(component, `${paths.bundles}/${component.componentId}/${component.release}`);
		for (const component of activationOrder.filter((component) => configurationImpacts(component.componentId)
			|| changedTargetIds.has(component.componentId))) await activateComponent(host, component, effective);
		await reconcileAiModeSelection(host, effective);
		for (const component of activationOrder.filter((component) => configurationImpacts(component.componentId)
			|| changedTargetIds.has(component.componentId))) await enrollProvider(host, component);
		if (routes.length) await requestSupervisor({ operation: 'edge.apply', caddyfile: renderCaddyfile(routes), aliases: subjectAlternativeNames(routes) });
	} catch (error) {
		recordEvent('reconcile.rollback-started', { generation, message: error instanceof Error ? error.message : String(error) });
		for (const component of componentStopOrder(host, effective).filter((component) => configurationImpacts(component.componentId)
			|| changedTargetIds.has(component.componentId))) {
			try { await stopComponent(component); } catch { /* continue restoring the last known-good generation */ }
		}
		await requestSupervisor({ operation: 'recovery.restore', generation });
		const rollbackPackages = [...refresh.previousCore.entries(), ...active.flatMap((component) => component.packages.map((item) => [item.name, item.version] as const))].map(([name, version]) => `${name}=${version}`);
		if (rollbackPackages.length) await requestSupervisor({ operation: 'apt.install', packages: [...new Set(rollbackPackages)] });
		try {
			for (const component of componentActivationOrder(host, active)) await activateRestoredComponent(component);
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

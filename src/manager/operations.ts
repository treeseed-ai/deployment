import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { hostConfigurationSchema, type HostConfiguration } from '@treeseed/sdk/deployment';
import { z } from 'zod';
import { loadCatalog } from '../catalog/load.js';
import { loadHostConfiguration, tryLoadHostConfiguration } from '../core/configuration.js';
import { recentEvents } from '../core/events.js';
import { paths } from '../core/paths.js';
import { requestSupervisor } from '../supervisor/client.js';
import type { ClientEnrollment } from '../supervisor/pki.js';
import { createPlan } from './plan.js';
import { composeFiles, managedConnectionEnvironment, managedContainerDevelopmentConnectionEnvironment, managedDevelopmentConnectionEnvironment, refreshAvailableCatalogs } from './reconcile.js';
import { serializedReconcile } from './serialized-reconcile.js';
import { serializedSecurityInitialize, serializedSecurityOperation } from './serialized-security.js';
import { loadUpdateState, noteDevelopmentPauseOwner, updatePaused } from './update-state.js';
import { loadActiveComponents, loadCurrentReceipt } from './current-state.js';
import { serializedReset } from './serialized-reset.js';
import { affectedDevelopmentClosure, DevelopmentSessionStore } from './development-sessions.js';
import { renderCaddyfile, subjectAlternativeNames } from '../edge/caddy.js';
import { inspectRecoveryBackup, listRecoveryBackups, restoreManagedGeneration } from './recovery.js';
import { aiModeStatus, requestAiMode } from './ai-mode.js';
import { cloudflareR2SecretIds, cloudflareR2StorageStatus, provisionCloudflareR2Storage, resetCloudflareR2Bucket } from './cloudflare-r2-storage.js';
import { credentialInitializerStatus, loadCredentialInitializers } from '../security/credential-initializers.js';
import { hostDevelopmentActivationSchema } from '../supervisor/host-development.js';
import { storageEnvironmentForRolloutGroup } from '../cloudflare/r2-replication-provisioning.js';
import { assertTreeDxResetSafe } from './reset-safety.js';

const bootstrapHandoffSchema = z.object({
	complete: z.boolean(),
	foundationReady: z.boolean().default(false),
	initializationRequired: z.boolean().default(false),
	installerCredentialsRetained: z.boolean(),
}).strict();

export const hostCommandRequestSchema = z.object({
	handlerId: z.string().regex(/^local\.(?:host|dev)(?:\.[a-z][a-z0-9-]*)+$/u),
	arguments: z.array(z.string().max(256)).max(16).default([]),
	options: z.record(z.union([z.string().max(1_100_000), z.number().finite(), z.boolean(), z.array(z.string().max(4_096)).max(32)])).default({}),
	configuration: hostConfigurationSchema.optional(),
}).strict();

export type HostCommandRequest = z.infer<typeof hostCommandRequestSchema>;

export function availableCatalogSummary(
	stablePath = `${paths.catalogs}/stable.json`,
	developmentPath = `${paths.catalogs}/development.json`,
	reader: typeof loadCatalog = loadCatalog,
	fileExists: typeof existsSync = existsSync,
) {
	try {
		const stable = reader(stablePath);
		const development = fileExists(developmentPath) ? reader(developmentPath) : undefined;
		return {
			compatible: true as const,
			requiresCoreUpdate: false,
			stable: { release: stable.release, generation: stable.generation, digest: stable.catalogDigest },
			development: development ? { release: development.release, generation: development.generation, digest: development.catalogDigest } : null,
		};
	} catch {
		// Metadata may legitimately be newer than this manager's SDK. Keep update
		// check useful and let explicit apply install the compatible core first.
		return { compatible: false as const, requiresCoreUpdate: true, stable: null, development: null };
	}
}

export const developmentEnvironmentPayloadSchema = z.object({
	sessionId: z.string().min(1),
	projectId: z.string().min(1),
	targetId: z.string().min(1),
}).strict();

function receipt() { return loadCurrentReceipt() ?? null; }

function plan() {
	const host = loadHostConfiguration(), stable = loadCatalog(`${paths.catalogs}/stable.json`), developmentPath = `${paths.catalogs}/development.json`;
	return createPlan(host, stable, existsSync(developmentPath) ? loadCatalog(developmentPath) : undefined, receipt() ?? undefined);
}

function developmentPayload(request: HostCommandRequest) {
	const payload = request.options.payload;
	if (typeof payload !== 'string') throw new Error('Development command requires a JSON payload.');
	return JSON.parse(payload) as unknown;
}

async function applyDevelopmentRoutes(store: DevelopmentSessionStore) {
	const routes = store.activeRoutes(plan().routes);
	if (routes.length) await requestSupervisor({ operation: 'edge.apply', caddyfile: renderCaddyfile(routes), aliases: subjectAlternativeNames(routes) });
	return routes;
}

function configurationPlan(configuration: HostConfiguration) {
	const stable = loadCatalog(`${paths.catalogs}/stable.json`), developmentPath = `${paths.catalogs}/development.json`;
	return createPlan(configuration, stable, existsSync(developmentPath) ? loadCatalog(developmentPath) : undefined, receipt() ?? undefined);
}

function requiredConfiguration(request: HostCommandRequest) {
	if (!request.configuration) throw new Error('A current-format host configuration is required.');
	return request.configuration;
}

async function replaceConfiguration(mutate: (host: HostConfiguration) => HostConfiguration) {
	const current = loadHostConfiguration();
	const candidate = mutate(structuredClone(current));
	candidate.generation = current.generation + 1;
	await requestSupervisor({ operation: 'configuration.replace', configuration: candidate });
	return serializedReconcile();
}

async function configureCloudflareR2(result: { accountId: string; bucket: string; environment: 'production' | 'staging'; credentialsChanged?: boolean }) {
	const host = loadHostConfiguration(), candidate = structuredClone(host), api = candidate.components.api;
	if (!api) throw new Error('The API component is not configured on this host.');
	candidate.secrets ??= {};
	for (const id of Object.values(cloudflareR2SecretIds)) candidate.secrets[id] = { provider: 'file', reference: `/etc/treeseed/credentials/${id}` };
	const configurableApi = api as typeof api & { configuration?: { environment?: Record<string, string>; secretEnvironment?: Record<string, string> } };
	configurableApi.configuration ??= {};
	configurableApi.configuration.environment ??= {};
	configurableApi.configuration.secretEnvironment ??= {};
	configurableApi.configuration.environment.TREESEED_LIBRARY_BRANCH = result.environment === 'production' ? 'main' : 'staging';
	Object.assign(configurableApi.configuration.secretEnvironment, {
		TREESEED_CLOUDFLARE_ACCOUNT_ID: cloudflareR2SecretIds.accountId,
		TREESEED_CLOUDFLARE_API_TOKEN: cloudflareR2SecretIds.managementToken,
		TREESEED_CONTENT_BUCKET_NAME: cloudflareR2SecretIds.bucketName,
		TREESEED_R2_ACCESS_KEY_ID: cloudflareR2SecretIds.accessKeyId,
		TREESEED_R2_SECRET_ACCESS_KEY: cloudflareR2SecretIds.secretAccessKey,
	});
	if (JSON.stringify(candidate) === JSON.stringify(host) && !result.credentialsChanged) return { changed: false, receipt: receipt() };
	candidate.generation = host.generation + 1;
	await requestSupervisor({ operation: 'configuration.replace', configuration: candidate });
	return { changed: true, receipt: await serializedReconcile(undefined, false, ['api']) };
}

function componentId(request: HostCommandRequest) {
	const value = request.arguments[0];
	if (!value || !/^[a-z][a-z0-9.-]{1,63}$/u.test(value)) throw new Error('A valid component identity is required.');
	return value;
}

export function updateTrack(request: Pick<HostCommandRequest, 'arguments' | 'options'>): 'stable' | 'development' {
	const value = request.options.track ?? request.arguments[0] ?? 'stable';
	if (value !== 'stable' && value !== 'development') throw new Error('Update track must be stable or development.');
	return value;
}

function bootstrapStatus() {
	const marker = `${paths.managerState}/bootstrap-status.json`;
	const handoff = existsSync(marker)
		? bootstrapHandoffSchema.parse(JSON.parse(readFileSync(marker, 'utf8')))
		: { complete: false, foundationReady: false, initializationRequired: true, installerCredentialsRetained: false };
	return { ...handoff, configurationInstalled: existsSync(paths.configuration), managerTlsReady: existsSync(`${paths.tls}/ca.crt`) };
}

export async function executeHostCommand(input: unknown, context: { local: boolean }) {
	const request = hostCommandRequestSchema.parse(input), host = tryLoadHostConfiguration();
	if (request.handlerId === 'local.host.uninstall') {
		if (!context.local) throw new Error('Host uninstall is available only through the protected local manager socket.');
		if (request.options.plan === true) return requestSupervisor({ operation: 'platform.uninstall.plan' });
		if (request.options.confirm !== true || request.options.yes !== true) throw new Error('Host uninstall requires --confirm and --yes after reviewing the plan.');
		await assertTreeDxResetSafe(host?.runtime.dataRoot ?? '/var/lib/treeseed/components');
		return requestSupervisor({ operation: 'platform.uninstall.execute', purgeSecurity: request.options.purgeSecurity === true, confirm: true });
	}
	if (!host) {
		if (!context.local || request.handlerId !== 'local.host.config.adopt') throw new Error('Current host configuration is invalid; adopt a current-format configuration through the protected local manager socket.');
		const candidate = requiredConfiguration(request);
		if (request.options.plan === true) return { recoveryRequired: true, configurationId: candidate.configurationId, generation: candidate.generation, mutation: false };
		if (request.options.confirm !== true) throw new Error('Configuration adoption requires --confirm.');
		await requestSupervisor({ operation: 'configuration.recover', configuration: candidate });
		await requestSupervisor({ operation: 'manager.restart' });
		return { adopted: true, recoveredInvalidConfiguration: true, configurationId: candidate.configurationId, generation: candidate.generation };
	}
	switch (request.handlerId) {
		case 'local.dev.host.activate': {
			if (!context.local) throw new Error('Host runtime development may be activated only through the protected local manager socket.');
			if (!host.fleet.rolloutGroup.toLowerCase().includes('development')) throw new Error('Host runtime development is restricted to development rollout groups.');
			const activation = hostDevelopmentActivationSchema.parse(developmentPayload(request));
			return requestSupervisor({ operation: 'host.development.activate', activation });
		}
		case 'local.dev.host.status':
			if (!context.local) throw new Error('Host runtime development status is available only through the protected local manager socket.');
			return requestSupervisor({ operation: 'host.development.status' });
		case 'local.dev.host.guest-image.import': {
			if (!context.local) throw new Error('Development guest images may be imported only through the protected local manager socket.');
			if (!host.fleet.rolloutGroup.toLowerCase().includes('development')) throw new Error('Development guest-image import is restricted to development rollout groups.');
			const payload = z.object({ archivePath: z.string().startsWith('/').max(4_096), image: z.string().regex(/^(?:docker\.io\/)?treeseed\/sandbox-[a-z0-9._-]+:local$/u) }).strict().parse(developmentPayload(request));
			return requestSupervisor({ operation: 'sandbox.guest-image.import', ...payload });
		}
		case 'local.dev.host.deactivate':
			if (!context.local) throw new Error('Host runtime development may be deactivated only through the protected local manager socket.');
			return requestSupervisor({ operation: 'host.development.deactivate' });
		case 'local.dev.session.start': {
			if (!context.local) throw new Error('Development sessions may be started only through the protected local manager socket.');
			const payload = z.object({ session: z.unknown(), runtimes: z.array(z.unknown()).min(1) }).strict().parse(developmentPayload(request));
			const started = new DevelopmentSessionStore().start(payload.session, payload.runtimes);
			noteDevelopmentPauseOwner(started.session.sessionId, true);
			return started;
		}
		case 'local.dev.session.stop': {
			if (!context.local) throw new Error('Development sessions may be stopped only through the protected local manager socket.');
			const payload = z.object({ sessionId: z.string().min(1) }).strict().parse(developmentPayload(request));
			const store = new DevelopmentSessionStore(), stopped = store.stop(payload.sessionId);
			noteDevelopmentPauseOwner(payload.sessionId, false);
			await applyDevelopmentRoutes(store); return stopped;
		}
		case 'local.dev.status': {
			const payload = z.object({ sessionId: z.string().min(1).optional(), all: z.boolean().default(false) }).strict().parse(developmentPayload(request));
			const store = new DevelopmentSessionStore();
			return payload.sessionId ? store.load(payload.sessionId) : { sessions: store.list(payload.all) };
		}
		case 'local.dev.plan': {
			const payload = z.object({ sessionId: z.string().min(1), selected: z.array(z.string().min(3)).default([]) }).strict().parse(developmentPayload(request));
			const record = new DevelopmentSessionStore().load(payload.sessionId);
			return { sessionId: payload.sessionId, affected: affectedDevelopmentClosure(record.runtimes, payload.selected.length ? payload.selected : record.session.targets.map((target) => `${target.projectId}.${target.targetId}`)) };
		}
		case 'local.dev.environment': {
			if (!context.local) throw new Error('Development runtime environment is available only through the protected local manager socket.');
			const payload = developmentEnvironmentPayloadSchema.parse(developmentPayload(request));
			const record = new DevelopmentSessionStore().load(payload.sessionId);
			const selected = record.session.targets.some((target) => target.projectId === payload.projectId && target.targetId === payload.targetId);
			const declared = record.runtimes.find((runtime) => runtime.project.id === payload.projectId)?.targets.find((target) => target.id === payload.targetId);
			if (!selected || !declared) throw new Error('Development environment target is outside the selected session.');
			const releases = loadActiveComponents(), component = releases.find((release) => release.componentId === payload.projectId);
			if (!component) return { environment: {} };
			const containerized = declared.operations.start?.environment.TREESEED_DEVELOPMENT_EDGE_HOST !== undefined;
			const connectionEnvironment = containerized
				? managedContainerDevelopmentConnectionEnvironment(host, component, releases, record.routes)
				: managedDevelopmentConnectionEnvironment(host, component, releases);
			return requestSupervisor<{ environment: Record<string, string> }>({ operation: 'development.environment', componentId: component.componentId, connectionEnvironment, secretRefs: declared.secretRefs });
		}
		case 'local.dev.candidate.register': {
			if (!context.local) throw new Error('Development candidates may be registered only through the protected local manager socket.');
			const payload = z.object({ sessionId: z.string().min(1), candidate: z.unknown() }).strict().parse(developmentPayload(request));
			return new DevelopmentSessionStore().registerCandidate(payload.sessionId, payload.candidate);
		}
		case 'local.dev.use': {
			if (!context.local) throw new Error('Development targets may be attached only through the protected local manager socket.');
			const payload = z.object({ sessionId: z.string().min(1), projectId: z.string().min(1), targetId: z.string().min(1), mode: z.enum(['released', 'candidate', 'live']), port: z.number().int().positive().max(65_535).optional() }).strict().parse(developmentPayload(request));
			const store = new DevelopmentSessionStore(); store.setMode(payload.sessionId, payload.projectId, payload.targetId, payload.mode);
			if (payload.mode !== 'released' && payload.port) await store.attach(payload.sessionId, payload.projectId, payload.targetId, payload.port);
			if (payload.mode !== 'released' && !payload.port) store.markReady(payload.sessionId, payload.projectId, payload.targetId);
			await applyDevelopmentRoutes(store);
			if (payload.mode !== 'released' && payload.port && !await store.verifyRouted(payload.sessionId, payload.projectId, payload.targetId)) {
				store.stop(payload.sessionId); noteDevelopmentPauseOwner(payload.sessionId, false); await applyDevelopmentRoutes(store); throw new Error('Canonical development route readiness failed; released routes were restored.');
			}
			return store.load(payload.sessionId);
		}
		case 'local.dev.rebuild': {
			const payload = z.object({ sessionId: z.string().min(1), projectId: z.string().min(1), targetId: z.string().min(1) }).strict().parse(developmentPayload(request));
			const store = new DevelopmentSessionStore(), record = store.load(payload.sessionId);
			const target = record.session.targets.find((entry) => entry.projectId === payload.projectId && entry.targetId === payload.targetId);
			if (!target) throw new Error('Development rebuild target is outside the selected session.');
			target.generation += 1; target.health = 'pending'; store.save(record); return { target, requested: true };
		}
		case 'local.dev.logs': {
			const payload = z.object({ sessionId: z.string().min(1), targetId: z.string().min(1).optional() }).strict().parse(developmentPayload(request));
			const record = new DevelopmentSessionStore().load(payload.sessionId);
			return { sessionId: payload.sessionId, targets: record.runtimes.flatMap((runtime) => runtime.targets.filter((target) => !payload.targetId || target.id === payload.targetId).map((target) => ({ projectId: runtime.project.id, targetId: target.id, logs: target.logs }))) };
		}
		case 'local.dev.freeze':
		case 'local.dev.verify': throw new Error('Candidate freeze and verification execute unprivileged through trsd.');
		case 'local.host.status': return { configurationId: host.configurationId, generation: host.generation, components: host.components, receipt: receipt(), updates: loadUpdateState() };
		case 'local.host.ai.mode.show': return aiModeStatus();
		case 'local.host.ai.mode.set': {
			const target = request.arguments[0];
			if (target !== 'awake' && target !== 'sleep') throw new Error('AI mode must be awake or sleep.');
			const requestValue = { schemaVersion: 'treeseed.ai-mode-request/v1', target, idempotencyKey: typeof request.options.idempotencyKey === 'string' ? request.options.idempotencyKey : randomUUID(), drainTimeoutSeconds: typeof request.options.drainTimeout === 'number' ? request.options.drainTimeout : typeof request.options.drainTimeout === 'string' ? Number(request.options.drainTimeout) : 900 };
			if (request.options.plan === true) return { ...aiModeStatus(), proposedMode: target, mutation: false };
			return requestAiMode(requestValue, 'operator');
		}
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
		case 'local.host.reconcile': return request.options.plan === true ? plan() : serializedReconcile();
		case 'local.host.events': return { events: recentEvents(100) };
		case 'local.host.config.show': return host;
		case 'local.host.config.plan': return configurationPlan(requiredConfiguration(request));
		case 'local.host.config.apply': {
			const candidate = requiredConfiguration(request);
			if (request.options.plan === true) return configurationPlan(candidate);
			await requestSupervisor({ operation: 'configuration.replace', configuration: candidate });
			return serializedReconcile();
		}
		case 'local.host.config.adopt': {
			const candidate = requiredConfiguration(request);
			if (request.options.plan === true) return configurationPlan(candidate);
			if (request.options.confirm !== true) throw new Error('Configuration adoption requires --confirm.');
			await requestSupervisor({ operation: 'configuration.adopt', configuration: candidate });
			return serializedReconcile();
		}
		case 'local.host.topology': {
			const accepted = plan();
			return { host: host.host, rolloutGroup: host.fleet.rolloutGroup, components: accepted.components.map(({ componentId, release, runtime }) => ({ componentId, release, dependencies: runtime.dependencies })), routes: accepted.routes, blockers: accepted.plan.blockers };
		}
		case 'local.host.connections': return { connections: Object.entries(host.components).filter(([, component]) => component.enabled).flatMap(([componentId, component]) => Object.entries(component.connections).map(([dependencyId, connection]) => ({ componentId, dependencyId, connection }))) };
		case 'local.host.provider.status': {
			const agent = host.components.agent;
			return { configured: agent?.enabled === true, hostId: host.host.id, role: host.host.role, state: agent?.enabled ? (receipt()?.packages.some((item) => item.name === 'treeseed-component-agent') ? 'installed' : 'pending-installation') : 'not-configured', controlPlane: agent?.connections['control-plane'] ?? null };
		}
		case 'local.host.provider.credentials.list': return { initializers: loadCredentialInitializers() };
		case 'local.host.provider.credentials.status': {
			const initializers = loadCredentialInitializers();
			const status = await requestSupervisor({ operation: 'provider.credentials.status', credentialIds: initializers.map(({ credentialId }) => credentialId) }) as { configuredCredentialIds: string[] };
			return { credentials: credentialInitializerStatus(status.configuredCredentialIds) };
		}
		case 'local.host.provider.credentials.initialize': {
			if (!context.local) throw new Error('Provider credential initialization is available only through the protected local manager socket.');
			const initializerId = z.string().regex(/^[a-z][a-z0-9.-]{1,63}$/u).parse(request.arguments[0]);
			const payload = z.object({ sourceId: z.string().regex(/^[a-z][a-z0-9.-]{1,63}$/u), secret: z.string().min(1).max(1_048_576) }).strict().parse(JSON.parse(String(request.options.payload ?? '')));
			return serializedSecurityOperation({ operation: 'provider.credential.initialize', initializerId, ...payload });
		}
		case 'local.host.security.plan': return requestSupervisor({ operation: 'security.plan' });
		case 'local.host.security.status': return requestSupervisor({ operation: 'security.status' });
		case 'local.host.security.verify': return requestSupervisor({ operation: 'security.verify' });
		case 'local.host.security.initialize': {
			if (!context.local) throw new Error('Host security initialization is available only through the protected local manager socket.');
			const payload = z.object({ bundle: z.string().startsWith('/'), recoveryPassphrase: z.string().min(12) }).strict().parse(JSON.parse(String(request.options.payload ?? '')));
			if (request.options.confirm !== true) throw new Error('Host security initialization requires --confirm.');
			return serializedSecurityInitialize({ operation: 'security.initialize', recoveryBundle: payload.bundle, recoveryPassphrase: payload.recoveryPassphrase, confirm: true });
		}
		case 'local.host.security.rotate': {
			if (!context.local) throw new Error('Host security rotation is available only through the protected local manager socket.');
			const target = z.enum(['volume', 'credentials', 'diagnostics']).parse(request.arguments[0]);
			if (request.options.confirm !== true) throw new Error('Host security rotation requires --confirm.');
			const payload = z.object({ recoveryBundle: z.string().startsWith('/'), recoveryPassphrase: z.string().min(12), newRecoveryBundle: z.string().startsWith('/'), newRecoveryPassphrase: z.string().min(12) }).strict().parse(JSON.parse(String(request.options.payload ?? '')));
			return requestSupervisor({ operation: 'security.rotate', target, ...payload, confirm: true });
		}
		case 'local.host.security.recovery.verify': {
			const payload = z.object({ bundle: z.string().startsWith('/'), recoveryPassphrase: z.string().min(12) }).strict().parse(JSON.parse(String(request.options.payload ?? '')));
			return requestSupervisor({ operation: 'security.recovery.verify', recoveryBundle: payload.bundle, recoveryPassphrase: payload.recoveryPassphrase });
		}
		case 'local.host.sandbox.status': return requestSupervisor({ operation: 'sandbox.status' });
		case 'local.host.sandbox.doctor': return requestSupervisor({ operation: 'sandbox.doctor' });
		case 'local.host.storage.status': {
			const payload = z.object({ action: z.literal('status'), backend: z.literal('cloudflare-r2'), teamId: z.string().min(1).max(256), teamSlug: z.string().min(1).max(256) }).passthrough().parse(JSON.parse(String(request.options.payload ?? '')));
			const host = loadHostConfiguration();
			return cloudflareR2StorageStatus(host.configurationId, storageEnvironmentForRolloutGroup(host.fleet.rolloutGroup));
		}
		case 'local.host.storage.reset': {
			if (!context.local) throw new Error('Host storage reset is available only through the protected local manager socket.');
			const payload = z.object({ action: z.literal('reset'), backend: z.literal('cloudflare-r2'),
				teamId: z.string().min(1).max(256), teamSlug: z.string().min(1).max(256),
				environment: z.enum(['production', 'staging']) }).passthrough().parse(JSON.parse(String(request.options.payload ?? '')));
			if (request.options.plan === true) return { backend: payload.backend, action: payload.action,
				environment: payload.environment, bucket: payload.environment === 'production' ? 'treeseed-library' : 'treeseed-dev-library', mutation: false };
			return resetCloudflareR2Bucket(loadHostConfiguration().configurationId, payload.environment);
		}
		case 'local.host.storage.connect':
		case 'local.host.storage.reconcile':
		case 'local.host.storage.rotate': {
			if (!context.local) throw new Error('Host storage mutation is available only through the protected local manager socket.');
			const payload = z.object({ action: z.enum(['connect', 'reconcile', 'rotate']), backend: z.literal('cloudflare-r2'), teamId: z.string().min(1).max(256), teamSlug: z.string().min(1).max(256),
				accountId: z.string().regex(/^[a-f0-9]{32}$/u).optional(), bootstrapToken: z.string().min(16).max(16_384).optional() }).passthrough().parse(JSON.parse(String(request.options.payload ?? '')));
			const host = loadHostConfiguration();
			const provisionInput = {
				action: payload.action, controlPlaneId: host.configurationId,
				environment: storageEnvironmentForRolloutGroup(host.fleet.rolloutGroup),
				...(payload.accountId ? { accountId: payload.accountId } : {}),
				...(payload.bootstrapToken ? { bootstrapToken: payload.bootstrapToken } : {}),
				plan: request.options.plan === true,
			};
			const result = await provisionCloudflareR2Storage(provisionInput);
			if (request.options.plan === true) return result;
			if (!('accountId' in result) || typeof result.accountId !== 'string') throw new Error('Cloudflare R2 provisioning did not return an account identity.');
			const configuration = await configureCloudflareR2(result);
			return { ...result, configuration };
		}
		case 'local.host.provider.enrollment': {
			if (!context.local) throw new Error('Provider enrollment is available only through the protected local manager socket.');
			const payload = z.discriminatedUnion('action', [
				z.object({ action: z.literal('begin'), connectionId: z.string().optional(), teamId: z.string().min(1).max(256), enrollmentToken: z.string().min(1).max(16_384) }).passthrough(),
				z.object({ action: z.literal('complete'), connectionId: z.string().regex(/^[a-z][a-z0-9.-]+$/u) }).passthrough(),
			]).parse(JSON.parse(String(request.options.payload ?? '')));
			const releases = loadActiveComponents(), agent = releases.find((component) => component.componentId === 'agent');
			if (!agent || !host.components.agent?.enabled) throw new Error('The managed Agent component is not active on this host.');
			if (payload.action === 'complete') return requestSupervisor({ operation: 'provider.enrollment-handoff', payload: { action: 'complete', connectionId: payload.connectionId }, files: composeFiles(agent), projectName: 'treeseed-agent' });
			const connectionId = payload.connectionId ?? `local-${payload.teamId}`;
			const environment = managedConnectionEnvironment(host, agent, releases);
			const controlPlaneUrl = environment.TREESEED_CONTROL_PLANE_URL;
			const controlPlaneAudience = environment.TREESEED_CONTROL_PLANE_AUDIENCE;
			if (!controlPlaneUrl || !controlPlaneAudience) throw new Error('The managed Agent control-plane connection is incomplete.');
			return requestSupervisor({ operation: 'provider.enrollment-handoff', payload: { action: 'begin', connectionId, teamId: payload.teamId, controlPlaneUrl, controlPlaneAudience, enrollmentToken: payload.enrollmentToken }, files: composeFiles(agent), projectName: 'treeseed-agent' });
		}
		case 'local.host.fleet.status': return { hostId: host.host.id, rolloutGroup: host.fleet.rolloutGroup, reporting: host.fleet.receiptReporting, receipt: receipt() };
		case 'local.host.update.status': return { policy: host.updates, state: loadUpdateState(), receipt: receipt() };
		case 'local.host.update.check': {
			await refreshAvailableCatalogs(host, undefined, false, true);
			return availableCatalogSummary();
		}
		case 'local.host.update.apply': return request.options.plan === true ? plan() : serializedReconcile(undefined, true);
		case 'local.host.update.channel': {
			const track = request.arguments[0];
			if (track !== 'stable' && track !== 'development') throw new Error('Update channel must be stable or development.');
			if (request.options.plan === true) return { track, mutation: false, nextGeneration: host.generation + 1 };
			return replaceConfiguration((candidate) => { candidate.updates.defaultTrack = track; return candidate; });
		}
		case 'local.host.update.pause':
		case 'local.host.update.resume': {
			const selected = updateTrack(request);
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
		case 'local.host.recovery.status': return {
			current: receipt(),
			backups: await listRecoveryBackups(),
			receipts: existsSync(paths.receipts) ? readdirSync(paths.receipts).filter((name) => name.endsWith('.json')).sort().slice(-20) : [],
		};
		case 'local.host.recovery.retry': return request.options.plan === true ? plan() : serializedReconcile();
		case 'local.host.recovery.restore': {
			const generation = Number(request.arguments[0]);
			if (!Number.isInteger(generation) || generation < 1) throw new Error('A positive recovery generation is required.');
			const target = await inspectRecoveryBackup(generation);
			if (request.options.plan === true) return {
				generation,
				mutation: false,
				targetReceiptId: target.receipt.receiptId,
				catalogDigest: target.receipt.catalogDigest,
				components: target.components.map(({ componentId, release }) => ({ componentId, release })),
				packages: target.receipt.packages,
			};
			return restoreManagedGeneration(generation);
		}
		case 'local.host.bootstrap.status': return bootstrapStatus();
		case 'local.host.bootstrap.enroll': {
			if (!context.local) throw new Error('Client enrollment is available only through the protected local manager socket.');
			if (request.options.plan === true) return { action: 'enroll', mutation: false };
			const clientId = `client-${randomUUID().toLowerCase()}`;
			return requestSupervisor<ClientEnrollment>({ operation: 'pki.enroll', clientId });
		}
		case 'local.host.reset': {
			if (!context.local) throw new Error('Host reset is available only through the protected local manager socket.');
			const affected = loadActiveComponents().map((component) => component.componentId).sort();
			if (request.options.plan === true) return { mutation: false, affected, removes: ['component-data', 'component-configuration', 'manager-receipts', 'provider-enrollments', 'update-state', 'backups'] };
			if (request.options.confirm !== true) throw new Error('Host reset requires --confirm.');
			return serializedReset();
		}
		default: throw new Error(`Unsupported host command ${request.handlerId}.`);
	}
}

import { arch, hostname } from 'node:os';
import { hostConfigurationSchema, type HostConfiguration, type HostInitializationProfile, type ReleaseCatalog } from '@treeseed/sdk/deployment';
import { developmentTreedxConfiguration, developmentTreedxSecretIds } from '../core/development-configuration.js';

export interface HostInitializationPlan {
	schemaVersion: 'treeseed.host-initialization-result/v1';
	mode: 'plan';
	profile: string;
	hostId: string;
	track: 'stable' | 'development';
	catalog: { release: string; generation: number; digest: string };
	role: HostInitializationProfile['role'];
	components: string[];
	inputs: HostInitializationProfile['inputs'];
	security: HostInitializationProfile['security'];
	configured: boolean;
	mutation: false;
}

interface SelectedInitializationProfile {
	catalog: ReleaseCatalog;
	profile: HostInitializationProfile;
}

const localDependencies: Record<string, { componentId: string; serviceId: string; endpointId: string }> = {
	'control-plane-api': { componentId: 'api', serviceId: 'api', endpointId: 'http' },
	'treeai-inference-api': { componentId: 'ai-inference', serviceId: 'inference-api', endpointId: 'inference' },
	'treeai-training-api': { componentId: 'ai-training', serviceId: 'training-api', endpointId: 'control' },
};

const developmentApiSecrets = {
	POSTGRES_PASSWORD: 'api-postgres-password',
	TREESEED_DATABASE_URL: 'api-database-url',
	SESSION_SECRET: 'api-session-secret',
	TREESEED_TREEDX_DELEGATION_PRIVATE_KEY: 'api-treedx-delegation-private-key',
	TREESEED_TREEDX_CREDENTIAL_BROKER_ASSERTION: 'treedx-credential-broker-assertion',
} as const;

export function runtimeHostId(value: string = hostname()) {
	let normalized = value.trim().toLowerCase().replaceAll(/[^a-z0-9.-]+/gu, '-').replace(/^[.-]+|[.-]+$/gu, '');
	if (!/^[a-z]/u.test(normalized)) normalized = `host-${normalized}`;
	normalized = normalized.slice(0, 64).replace(/[.-]+$/gu, '');
	if (!/^[a-z][a-z0-9.-]{1,63}$/u.test(normalized)) throw new Error('The runtime hostname cannot be normalized to a valid TreeSeed host identity.');
	return normalized;
}

function runtimeArchitecture(value: string = arch()) {
	if (value === 'x64') return 'amd64';
	if (value === 'arm64') return 'arm64';
	throw new Error(`Unsupported TreeSeed host architecture: ${value}`);
}

function selectHostInitializationProfile(profileId: string, stable: ReleaseCatalog, development?: ReleaseCatalog): SelectedInitializationProfile {
	if (!/^[a-z][a-z0-9.-]{1,63}$/u.test(profileId)) throw new Error('A valid host initialization profile is required.');
	for (const catalog of [...(development ? [development] : []), stable]) {
		const profile = catalog.hostProfiles.find(({ id }) => id === profileId);
		if (profile) return { catalog, profile };
	}
	throw new Error(`Host initialization profile ${profileId} is not present in an installed verified catalog.`);
}

export function planHostInitialization(profileId: string, stable: ReleaseCatalog, development?: ReleaseCatalog, current?: HostConfiguration, hostName?: string): HostInitializationPlan {
	const selected = selectHostInitializationProfile(profileId, stable, development);
	const configured = Boolean(current);
	if (current) {
		const currentProfiles = new Set(Object.values(current.components).map(({ profile }) => profile).filter(Boolean));
		if (current.host.role !== selected.profile.role || currentProfiles.size !== 1 || !currentProfiles.has(profileId)) throw new Error('This host already has a different configuration; use explicit configuration adoption or uninstall first.');
	}
	return {
		schemaVersion: 'treeseed.host-initialization-result/v1', mode: 'plan', profile: profileId,
		hostId: current?.host.id ?? runtimeHostId(hostName),
		track: selected.catalog.track, catalog: { release: selected.catalog.release, generation: selected.catalog.generation, digest: selected.catalog.catalogDigest },
		role: selected.profile.role, components: [...selected.profile.components], inputs: selected.profile.inputs.map((input) => ({ ...input })),
		security: { ...selected.profile.security }, configured, mutation: false,
	};
}

function localConnections(selected: SelectedInitializationProfile, componentId: string) {
	const components = new Set(selected.profile.components), release = selected.catalog.components.find((candidate) => candidate.componentId === componentId);
	if (!release) throw new Error(`Host initialization component ${componentId} is absent from the selected catalog.`);
	const connections: Record<string, { kind: 'local'; componentId: string; serviceId: string; endpointId: string }> = {};
	for (const dependency of release.runtime.dependencies) {
		const target = localDependencies[dependency.capability];
		if (!target || !components.has(target.componentId)) {
			if (dependency.optional) continue;
			throw new Error(`Host initialization cannot resolve required local capability ${dependency.capability} for ${componentId}.`);
		}
		const targetRelease = selected.catalog.components.find((candidate) => candidate.componentId === target.componentId);
		const endpoint = targetRelease?.runtime.services.find(({ id }) => id === target.serviceId)?.endpoints.find(({ id }) => id === target.endpointId);
		if (!endpoint) throw new Error(`Host initialization catalog does not expose ${target.componentId}.${target.serviceId}.${target.endpointId}.`);
		connections[dependency.id] = { kind: 'local', ...target };
	}
	return connections;
}

function developmentApiConfiguration(selectedComponents: Set<string>) {
	const apiUrl = 'https://api.treeseed.localhost';
	const environment: Record<string, string> = {
		NODE_ENV: 'production', POSTGRES_USER: 'treeseed', POSTGRES_DB: 'treeseed_api', TREESEED_ENVIRONMENT: 'local',
		TREESEED_LOCAL_DEV_MODE: '1', TREESEED_API_BASE_URL: apiUrl, TREESEED_SITE_URL: 'https://admin.treeseed.localhost',
		TREESEED_API_AUTH_APPROVAL_BASE_URL: 'https://admin.treeseed.localhost', TREESEED_TREEDX_JWT_ISSUER: `${apiUrl}/treedx`,
		TREESEED_TREEDX_JWT_AUDIENCE: 'treedx',
	};
	if (selectedComponents.has('lab')) Object.assign(environment, { TREESEED_MAILPIT_SMTP_HOST: 'mailpit', TREESEED_MAILPIT_SMTP_PORT: '1025' });
	if (selectedComponents.has('treedx')) environment.TREESEED_TREEDX_URL = 'http://treedx:4000';
	return { environment, secretEnvironment: { ...developmentApiSecrets } };
}

function componentInitializationConfiguration(selected: SelectedInitializationProfile, componentId: string, environment: HostConfiguration['runtime']['environment'], selectedComponents: Set<string>) {
	const release = selected.catalog.components.find((candidate) => candidate.componentId === componentId);
	if (!release) throw new Error(`Host initialization component ${componentId} is absent from the selected catalog.`);
	const files = Object.fromEntries(release.runtime.configuration.files.flatMap((declaration) => {
		if (declaration.default !== undefined) return [[declaration.id, declaration.default]];
		if (declaration.required) throw new Error(`Zero-input host initialization requires package-owned default content for ${componentId} managed file ${declaration.id}.`);
		return [];
	}));
	const configuration = environment !== 'development' ? {}
		: componentId === 'api' ? developmentApiConfiguration(selectedComponents)
			: componentId === 'treedx' ? developmentTreedxConfiguration() : {};
	return Object.keys(files).length ? { ...configuration, files } : configuration;
}

function requiredSecurity(selected: SelectedInitializationProfile) {
	if (selected.profile.security.requirement !== 'required') return undefined;
	const agent = selected.catalog.components.find(({ componentId }) => componentId === 'agent');
	const guest = agent?.images.find(({ role }) => role === 'sandbox-guest');
	if (!guest) throw new Error('A security-required host profile must select an Agent release with an immutable sandbox guest image.');
	return {
		sandbox: {
			required: true as const, runtime: 'kata-runtime-rs-qemu' as const, brokerSocket: '/run/treeseed/sandbox/broker.sock',
			modelGateway: { provider: 'openai' as const, upstreamBaseUrl: 'https://api.openai.com' as const, allowedModels: ['gpt-5.4'] },
			profiles: ['read', 'unit', 'integration', 'platform', 'connected'].map((id) => ({ id, guestImage: guest.repository, guestImageDigest: guest.digest })),
		},
		providerVolume: { encryption: 'luks2' as const, backingPath: '/var/lib/treeseed/encrypted/provider-data.luks', mountPath: '/var/lib/treeseed/agent', sizeBytes: 17_179_869_184, unlock: 'systemd-credential' as const, recoveryRequired: true as const },
		applicationEncryption: { provider: 'systemd-credential' as const, activeKeyVersion: 1, diagnosticsKeyVersion: 1 },
	};
}

export function renderHostInitializationConfiguration(profileId: string, stable: ReleaseCatalog, development?: ReleaseCatalog, hostName?: string): HostConfiguration {
	const selected = selectHostInitializationProfile(profileId, stable, development);
	if (selected.profile.inputs.length) throw new Error('Host initialization profiles with external inputs remain disabled until their one-time handoff is accepted. No input was retained.');
	const hostId = runtimeHostId(hostName), environment = selected.profile.runtime.environment === 'track-default'
		? selected.catalog.track === 'stable' ? 'production' : 'development'
		: selected.profile.runtime.environment;
	const selectedComponents = new Set(selected.profile.components);
	const components = Object.fromEntries(selected.profile.components.map((componentId) => [componentId, {
		enabled: true, track: selected.catalog.track, profile: selected.profile.id, aliases: {},
		configuration: componentInitializationConfiguration(selected, componentId, environment, selectedComponents),
		resources: { gpuDevices: [] }, connections: localConnections(selected, componentId),
	}]));
	const developmentSecretIds = environment !== 'development' ? [] : [
		...(selectedComponents.has('api') ? Object.values(developmentApiSecrets) : []),
		...(selectedComponents.has('treedx') ? Object.values(developmentTreedxSecretIds) : []),
	];
	const secrets = Object.fromEntries([...new Set(developmentSecretIds)].map((id) => [id, { provider: 'file' as const, reference: `/etc/treeseed/credentials/${id}` }]));
	const security = requiredSecurity(selected);
	return hostConfigurationSchema.parse({
		schemaVersion: 'treeseed.host/v1', configurationId: hostId, generation: 1,
		host: { id: hostId, role: selected.profile.role, architecture: runtimeArchitecture() },
		runtime: { management: 'managed', environment, ...(environment === 'development' ? { dataRoot: '/var/lib/treeseed/development/.treeseed/data' } : {}) },
		updates: { defaultTrack: selected.catalog.track, stable: { metadataPollSeconds: 86_400, maintenanceWindow: { weekday: 'sunday', localTime: '03:00', jitterMinutes: 20 } }, development: { pollSeconds: 60 } },
		components, network: { manager: { binding: '127.0.0.1:4790', aliases: ['manager.treeseed.localhost'], sans: ['manager.treeseed.localhost', '127.0.0.1'], trustedLanCidrs: [] } },
		fleet: { rolloutGroup: `${selected.profile.id}-${selected.catalog.track}`, receiptReporting: { enabled: false, intervalSeconds: 300 } },
		secrets, ...(security ? { security } : {}),
	});
}

export function validateHostInitializationInputs(plan: HostInitializationPlan, values: unknown) {
	if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Host initialization inputs must be an object.');
	const record = values as Record<string, unknown>, accepted = new Set(plan.inputs.map(({ name }) => name));
	const unknown = Object.keys(record).filter((name) => !accepted.has(name));
	if (unknown.length) throw new Error(`Host initialization contains undeclared inputs: ${unknown.sort().join(', ')}.`);
	for (const descriptor of plan.inputs) {
		const value = record[descriptor.name];
		if (descriptor.required && (typeof value !== 'string' || value.length === 0)) throw new Error(`Required host initialization input ${descriptor.name} was not provided.`);
		if (value !== undefined && (typeof value !== 'string' || value.length > 16_384)) throw new Error(`Host initialization input ${descriptor.name} is invalid.`);
	}
	const controlPlaneUrl = record.controlPlaneUrl;
	if (typeof controlPlaneUrl === 'string' && !controlPlaneUrl.startsWith('https://')) throw new Error('Control-plane URL must use HTTPS.');
	return Object.keys(record).sort();
}

import { describe, expect, it } from 'vitest';
import { hostInitializationProfileSchema, type ReleaseCatalog } from '@treeseed/sdk/deployment';
import { planHostInitialization, renderHostInitializationConfiguration, runtimeHostId, validateHostInitializationInputs } from '../src/manager/initialization.js';
import { component } from './fixtures.js';

const digest = `sha256:${'a'.repeat(64)}`;
function catalog(): ReleaseCatalog {
	const profile = hostInitializationProfileSchema.parse({ schemaVersion: 'treeseed.host-initialization-profile/v1', id: 'capacity-provider', role: 'capacity-provider', runtime: { management: 'managed', environment: 'track-default' }, components: ['agent'], security: { requirement: 'required' }, inputs: [
		{ name: 'controlPlaneUrl', required: true, sensitive: false, description: 'Control-plane API HTTPS URL' },
		{ name: 'teamRegistrationCode', required: true, sensitive: true, description: 'Team registration code' },
	] });
	return { schemaVersion: 'treeseed.release-catalog/v1', release: '0.1.0~rc183', generation: 144, track: 'development', compatibilityId: 'treeseed-linux-amd64-v1', catalogDigest: digest, stableBase: { release: '0.1.0', catalogDigest: digest }, components: [], hostProfiles: [profile], createdAt: '2026-08-31T17:30:00.000Z' };
}

function integratedCatalog(): ReleaseCatalog {
	const api = component('api', 'development', 'b', 'api.treeseed.localhost');
	api.runtime.services[0]!.id = 'api'; api.runtime.services[0]!.composeService = 'api';
	const admin = component('admin', 'development', 'c', 'admin.treeseed.localhost');
	admin.runtime.dependencies = [{ id: 'api', capability: 'control-plane-api', locality: 'either', optional: false }];
	const agent = component('agent', 'development', 'd');
	agent.runtime.services = [{ id: 'manager', composeService: 'manager', endpoints: [] }, { id: 'runner', composeService: 'runner', endpoints: [] }];
	agent.runtime.dependencies = [{ id: 'control-plane', capability: 'control-plane-api', locality: 'either', optional: false }];
	agent.runtime.configuration.files = [{ id: 'treeseed.capacity-provider.yaml', path: '/etc/treeseed/components/agent/treeseed.capacity-provider.yaml', required: true, sensitive: false, default: 'schemaVersion: 5\nconnections: []\n' }];
	agent.images[0] = { ...agent.images[0]!, role: 'sandbox-guest', repository: 'treeseed/sandbox-codex' };
	const treedx = component('treedx', 'development', 'e', 'treedx.treeseed.localhost');
	treedx.runtime.dependencies = [{ id: 'control-plane', capability: 'control-plane-api', locality: 'either', optional: false }];
	treedx.runtime.configuration.environment = ['TREEDX_GIT_ALLOWED_HOSTS', 'TREEDX_JWT_ALLOWED_ALGS', 'TREEDX_JWT_AUDIENCE', 'TREEDX_JWT_ISSUER', 'TREEDX_REMOTE_CREDENTIAL_BROKER_SERVICE_ID']
		.map((name) => ({ name, required: true, source: 'configuration' as const }));
	treedx.runtime.configuration.secretEnvironment = ['TREEDX_REMOTE_CREDENTIAL_BROKER_ASSERTION', 'TREEDX_SECRET_KEY_BASE'].map((name) => ({ name, required: true }));
	const lab = component('lab', 'development', 'f', 'lab.treeseed.localhost');
	const profile = hostInitializationProfileSchema.parse({ schemaVersion: 'treeseed.host-initialization-profile/v1', id: 'core', role: 'integrated', runtime: { management: 'managed', environment: 'track-default' }, components: ['api', 'admin', 'agent', 'treedx', 'lab'], security: { requirement: 'required' }, inputs: [] });
	return { ...catalog(), components: [api, admin, agent, treedx, lab], hostProfiles: [profile] };
}

describe('host initialization planning', () => {
	it('selects an exact catalog profile without returning values', () => {
		const stable = { ...catalog(), track: 'stable' as const, release: '0.1.0', generation: 36, stableBase: null, hostProfiles: [] };
		const plan = planHostInitialization('capacity-provider', stable, catalog());
		expect(plan).toMatchObject({ mode: 'plan', profile: 'capacity-provider', track: 'development', components: ['agent'], configured: false, mutation: false });
		expect(JSON.stringify(plan)).not.toContain('private-code');
	});

	it('validates all and only declared inputs while returning names only', () => {
		const stable = { ...catalog(), track: 'stable' as const, release: '0.1.0', generation: 36, stableBase: null, hostProfiles: [] };
		const plan = planHostInitialization('capacity-provider', stable, catalog());
		expect(validateHostInitializationInputs(plan, { controlPlaneUrl: 'https://api.example.test', teamRegistrationCode: 'private-code' })).toEqual(['controlPlaneUrl', 'teamRegistrationCode']);
		expect(() => validateHostInitializationInputs(plan, { controlPlaneUrl: 'http://api.example.test', teamRegistrationCode: 'private-code' })).toThrow(/HTTPS/u);
		expect(() => validateHostInitializationInputs(plan, { controlPlaneUrl: 'https://api.example.test', invented: 'value' })).toThrow(/undeclared/u);
	});

	it('fails closed for profiles absent from installed catalogs', () => {
		const stable = { ...catalog(), track: 'stable' as const, release: '0.1.0', generation: 36, stableBase: null, hostProfiles: [] };
		expect(() => planHostInitialization('treeai', stable)).toThrow(/not present/u);
	});

	it('renders a portable zero-input core configuration from the exact catalog', () => {
		const development = integratedCatalog();
		const stable = { ...catalog(), track: 'stable' as const, release: '0.1.0', generation: 36, stableBase: null, hostProfiles: [] };
		const rendered = renderHostInitializationConfiguration('core', stable, development, 'runtime-host');
		expect(rendered).toMatchObject({ configurationId: 'runtime-host', generation: 1, host: { id: 'runtime-host', role: 'integrated' },
			runtime: { management: 'managed', environment: 'development', dataRoot: '/var/lib/treeseed/development/.treeseed/data' },
			fleet: { rolloutGroup: 'core-development', receiptReporting: { enabled: false } } });
		expect(Object.keys(rendered.components)).toEqual(['api', 'admin', 'agent', 'treedx', 'lab']);
		expect(rendered.components.agent?.connections['control-plane']).toEqual({ kind: 'local', componentId: 'api', serviceId: 'api', endpointId: 'http' });
		expect(rendered.components.treedx?.connections['control-plane']).toEqual({ kind: 'local', componentId: 'api', serviceId: 'api', endpointId: 'http' });
		expect(rendered.components.api?.configuration).toMatchObject({ secretEnvironment: { TREESEED_DATABASE_URL: 'api-database-url' } });
		expect(rendered.components.treedx?.configuration).toEqual({
			environment: { TREEDX_GIT_ALLOWED_HOSTS: 'github.com', TREEDX_JWT_ALLOWED_ALGS: 'RS256', TREEDX_JWT_AUDIENCE: 'treedx', TREEDX_JWT_ISSUER: 'https://api.treeseed.localhost/treedx', TREEDX_REMOTE_CREDENTIAL_BROKER_SERVICE_ID: 'treedx' },
			secretEnvironment: { TREEDX_REMOTE_CREDENTIAL_BROKER_ASSERTION: 'treedx-credential-broker-assertion', TREEDX_SECRET_KEY_BASE: 'treedx-secret-key-base' },
		});
		expect(rendered.secrets['treedx-secret-key-base']).toEqual({ provider: 'file', reference: '/etc/treeseed/credentials/treedx-secret-key-base' });
		expect(rendered.components.agent?.configuration).toEqual({ files: { 'treeseed.capacity-provider.yaml': 'schemaVersion: 5\nconnections: []\n' } });
		expect(rendered.security?.sandbox.profiles.every(({ guestImage }) => guestImage === 'treeseed/sandbox-codex')).toBe(true);
		expect(JSON.stringify(rendered)).not.toMatch(/adrian|\/home\//u);
	});

	it('fails closed when a zero-input profile selects a required file without a package-owned default', () => {
		const development = integratedCatalog();
		development.components.find(({ componentId }) => componentId === 'agent')!.runtime.configuration.files[0]!.default = undefined;
		const stable = { ...catalog(), track: 'stable' as const, release: '0.1.0', generation: 36, stableBase: null, hostProfiles: [] };
		expect(() => renderHostInitializationConfiguration('core', stable, development, 'runtime-host')).toThrow(/package-owned default content/u);
	});

	it('normalizes runtime identity and refuses external-input execution rendering', () => {
		expect(runtimeHostId(' 03-Capacity Provider ')).toBe('host-03-capacity-provider');
		const stable = { ...catalog(), track: 'stable' as const, release: '0.1.0', generation: 36, stableBase: null, hostProfiles: [] };
		const development = catalog();
		const agent = component('agent', 'development', 'b');
		agent.images[0] = { ...agent.images[0]!, role: 'sandbox-guest' };
		agent.runtime.dependencies = [{ id: 'control-plane', capability: 'control-plane-api', locality: 'either', optional: false }];
		development.components = [agent];
		const rendered = renderHostInitializationConfiguration('capacity-provider', stable, development, 'provider-01', {
			controlPlaneUrl: 'https://api.example.test/', teamRegistrationCode: 'registration-code',
		});
		expect(rendered.components.agent?.connections['control-plane']).toEqual({ kind: 'remote', url: 'https://api.example.test', audience: 'https://api.example.test',
			tls: { trust: 'system' }, authentication: { mode: 'none' }, healthGate: { protocol: 'http', path: '/v1/health/ready', timeoutSeconds: 120 } });
		expect(rendered.components.agent?.configuration.providerEnrollment).toEqual({ connectionId: 'primary', registrationSecretId: 'provider-registration',
			offer: { maxConcurrentRunners: 1, capabilities: [] } });
		expect(JSON.stringify(rendered)).not.toContain('registration-code');
	});
});

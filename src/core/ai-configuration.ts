import { hostConfigurationSchema, type HostConfiguration } from '@treeseed/sdk/deployment';
import { isDeepStrictEqual } from 'node:util';
import { aiCredentialNames } from '../supervisor/ai-credentials.js';
import { aiStorageIdentityNames } from '../supervisor/ai/storage-identity.js';

export interface ManagedAiBinding {
	nodeId: string; teamId: string; projectId: string; issuer: string;
	publicKeys: Array<{ kty: string; kid: string; alg: string; use: string; n: string; e: string }>;
}

/** Public configuration only. Values are generated inside the supervisor's sealed custody. */
export function planManagedAiConfiguration(current: HostConfiguration, binding: ManagedAiBinding) {
	const host = hostConfigurationSchema.parse(current);
	if (!host.components.api?.enabled || !host.security) throw new Error('Managed API and initialized host security are required.');
	if (![binding.nodeId, binding.teamId, binding.projectId].every(id => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(id))) throw new Error('AI binding requires exact runtime, team, and project UUIDs.');
	const issuer = new URL(binding.issuer);
	if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash || issuer.pathname !== '/ai') throw new Error('AI delegation issuer must be the HTTPS control-plane AI authority.');
	if (!Array.isArray(binding.publicKeys) || !binding.publicKeys.length || binding.publicKeys.length > 8 || binding.publicKeys.some(key => !key || key.kty !== 'RSA' || key.alg !== 'RS256' || key.use !== 'sig' || !key.kid || !key.n || !key.e || Object.keys(key).some(name => !['kty', 'kid', 'alg', 'use', 'n', 'e'].includes(name)))) throw new Error('AI trust accepts public RSA signing keys only.');
	const runtime = JSON.stringify({ nodeId: binding.nodeId, teamId: binding.teamId, projectId: binding.projectId,
		endpoints: { inference: 'http://inference-api:4770', training: 'http://training-api:4780', lab: 'http://controller:8081', gateway: 'http://inference-api:4771' } });
	const api = host.components.api.configuration;
	const apiEnvironment = { ...api.environment as Record<string, string> };
	if (apiEnvironment.TREESEED_AI_RUNTIME && apiEnvironment.TREESEED_AI_RUNTIME !== runtime) throw new Error('An existing managed AI identity cannot be silently replaced.');
	api.environment = { ...apiEnvironment, TREESEED_AI_RUNTIME: runtime };
	for (const [id, name] of Object.entries({ ...aiCredentialNames, ...Object.fromEntries(Object.values(aiStorageIdentityNames).map(id => [id, id])) })) {
		const secret = { provider: 'systemd-credential' as const, reference: `/etc/treeseed/credentials/${name}.cred` };
		if (host.secrets[id] && JSON.stringify(host.secrets[id]) !== JSON.stringify(secret)) throw new Error(`AI credential ${id} requires an explicit custody migration.`);
		host.secrets[id] = secret;
	}
	const storageCa = { provider: 'file' as const, reference: '/etc/treeseed/credentials/ai-storage-ca' };
	if (host.secrets['ai-storage-ca'] && !isDeepStrictEqual(host.secrets['ai-storage-ca'], storageCa)) throw new Error('AI storage TLS trust requires explicit custody reconciliation.');
	host.secrets['ai-storage-ca'] = storageCa;
	for (const [id, name] of Object.entries({ 'ai-mode-ca': 'ai-mode-ca.crt', 'ai-mode-client-cert': 'ai-mode-client.crt', 'ai-mode-client-key': 'ai-mode-client.key' })) {
		const secret = { provider: 'file' as const, reference: `/etc/treeseed/credentials/${name}` };
		if (host.secrets[id] && JSON.stringify(host.secrets[id]) !== JSON.stringify(secret)) throw new Error('AI mode identity requires explicit reconciliation.');
		host.secrets[id] = secret;
	}
	for (const role of ['inference', 'training', 'lab'] as const) {
		const id = `ai-${role}`, previous = host.components[id];
		const environment = { ...previous?.configuration.environment as Record<string, string>,
			AI_DELEGATION_ISSUER: binding.issuer, AI_DELEGATION_AUDIENCE: `treeai:${binding.nodeId}:${role}`,
			AI_TEAM_ID: binding.teamId, AI_NODE_ID: binding.nodeId, AI_DELEGATION_PUBLIC_KEYS: JSON.stringify(binding.publicKeys),
			...(role === 'lab' ? {} : { AI_PROJECT_ID: binding.projectId, AI_STORAGE_SERVICE: role,
				AI_STORAGE_URL: new URL('/v1/internal/ai/storage/credentials', binding.issuer).href,
				AI_STORAGE_HOST: issuer.hostname }),
		};
		const secretEnvironment = role === 'lab' ? { AI_LAB_API_KEYS: 'ai-lab-api-keys' } : {
			[`${role.toUpperCase()}_DATABASE_URL`]: `ai-${role}-database-url`,
			[`${role.toUpperCase()}_POSTGRES_PASSWORD`]: `ai-${role}-postgres-password`, AI_API_KEYS: `ai-${role}-api-keys`,
		};
		host.components[id] = { track: host.updates.defaultTrack, aliases: {}, resources: { gpuDevices: [] }, connections: {}, ...previous, enabled: true,
			configuration: { ...previous?.configuration, environment, secretEnvironment } };
		if (role === 'lab') host.components[id]!.connections = {
			...host.components[id]!.connections,
			inference: { kind: 'local', componentId: 'ai-inference', serviceId: 'inference-api', endpointId: 'control' },
			training: { kind: 'local', componentId: 'ai-training', serviceId: 'training-api', endpointId: 'control' },
		};
	}
	const parsed = hostConfigurationSchema.parse(host);
	const noop = isDeepStrictEqual(parsed, hostConfigurationSchema.parse(current));
	if (!noop) host.generation++;
	return { configuration: hostConfigurationSchema.parse(host), noop };
}

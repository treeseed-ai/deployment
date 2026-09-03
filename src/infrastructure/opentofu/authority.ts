import type { HostedInfrastructureWorkspace } from './workspace.js';
import { infrastructureDigest } from './toolchain.js';
import { resolve } from 'node:path';

export type HostedInfrastructureEnvironment = 'staging' | 'production';
export type HostedInfrastructureCredentialProfile = 'cloudflare-runtime' | 'cloudflare-dns' | 's3-state-session' | 'railway-workspace' | 'opentofu-state-encryption';

export interface HostedInfrastructureAuthorityRequest {
	requestId: string;
	teamId: string;
	deploymentId: string;
	stackId: string;
	environment: HostedInfrastructureEnvironment;
	backendBindingDigest: string;
	provider: 'cloudflare' | 'railway' | 'treeseed';
	connectionRef: string;
	secretRef?: string;
	credentialProfileId: HostedInfrastructureCredentialProfile;
	capabilities: string[];
	purpose: 'provider' | 'state-backend' | 'state-encryption';
}

export interface HostedInfrastructureVaultMaterial {
	schemaVersion: 'treeseed.service-credential-material/v1';
	source: 'treeseed-service-credential-vault';
	requestId: string;
	teamId: string;
	deploymentId: string;
	stackId: string;
	authorityId: string;
	authorityVersion: number;
	environment: HostedInfrastructureEnvironment;
	backendBindingDigest: string;
	provider: 'cloudflare' | 'railway' | 'treeseed';
	connectionRef: string;
	secretRef?: string;
	credentialProfileId: HostedInfrastructureCredentialProfile;
	capabilities: string[];
	purpose: 'provider' | 'state-backend' | 'state-encryption';
	scheme: 'environment-reference' | 'client-encrypted' | 'external-vault' | 'workload-identity';
	expiresAt: string | null;
	values: Record<string, string>;
}

export interface HostedInfrastructureVaultAuthority {
	schemaVersion: 'treeseed.hosted-infrastructure-authority/v1';
	environment: HostedInfrastructureEnvironment;
	materials: HostedInfrastructureVaultMaterial[];
}

export type HostedInfrastructureVaultResolver = (request: HostedInfrastructureAuthorityRequest) => Promise<HostedInfrastructureVaultMaterial>;

export function hostedInfrastructureAuthorityBindingDigest(authority: HostedInfrastructureVaultAuthority) {
	return infrastructureDigest({ schemaVersion: authority.schemaVersion, environment: authority.environment, materials: authority.materials.map(({ values: _values, ...material }) => material).sort((left, right) => left.requestId.localeCompare(right.requestId)) });
}

const allowedVariables: Record<HostedInfrastructureCredentialProfile, readonly string[]> = {
	'cloudflare-runtime': ['apiToken'],
	'cloudflare-dns': ['apiToken'],
	's3-state-session': ['accessKeyId', 'secretAccessKey', 'sessionToken'],
	'railway-workspace': ['apiToken'],
	'opentofu-state-encryption': ['key'],
};

function processBindings(material: HostedInfrastructureVaultMaterial) {
	if (material.credentialProfileId === 'cloudflare-runtime') return { TF_VAR_cloudflare_runtime_token: material.values.apiToken! };
	if (material.credentialProfileId === 'cloudflare-dns') return { TF_VAR_cloudflare_dns_token: material.values.apiToken! };
	if (material.credentialProfileId === 's3-state-session') return { AWS_ACCESS_KEY_ID: material.values.accessKeyId!, AWS_SECRET_ACCESS_KEY: material.values.secretAccessKey!,
		...(material.values.sessionToken ? { AWS_SESSION_TOKEN: material.values.sessionToken } : {}) };
	if (material.credentialProfileId === 'opentofu-state-encryption') return { TF_ENCRYPTION: `key_provider "static" "treeseed" { key = "${material.values.key}" encrypted_metadata_alias = "treeseed-state" }\nmethod "aes_gcm" "treeseed" { keys = key_provider.static.treeseed }\nstate { method = method.aes_gcm.treeseed enforced = true }\nplan { method = method.aes_gcm.treeseed enforced = true }` };
	return { RAILWAY_TOKEN: material.values.apiToken! };
}

function validateMaterial(request: HostedInfrastructureAuthorityRequest, material: HostedInfrastructureVaultMaterial, now: Date) {
	if (material.schemaVersion !== 'treeseed.service-credential-material/v1' || material.source !== 'treeseed-service-credential-vault') throw new Error('Hosted infrastructure authority must originate from the TreeSeed service credential vault.');
	for (const field of ['requestId', 'teamId', 'deploymentId', 'stackId', 'environment', 'backendBindingDigest', 'provider', 'connectionRef', 'credentialProfileId', 'purpose'] as const) if (material[field] !== request[field]) throw new Error(`Hosted infrastructure vault material does not match ${field}.`);
	if (material.secretRef !== request.secretRef) throw new Error('Hosted infrastructure vault material does not match secretRef.');
	if (!material.authorityId || !Number.isInteger(material.authorityVersion) || material.authorityVersion < 1) throw new Error('Hosted infrastructure vault material has no versioned authority identity.');
	if (request.capabilities.some((capability) => !material.capabilities.includes(capability))) throw new Error('Hosted infrastructure vault material is missing a required capability.');
	if (material.expiresAt !== null && new Date(material.expiresAt).getTime() <= now.getTime()) throw new Error('Hosted infrastructure vault material has expired.');
	if (request.purpose !== 'provider' && (material.expiresAt === null || new Date(material.expiresAt).getTime() > now.getTime() + 60 * 60 * 1_000)) throw new Error('Hosted infrastructure state authority must be a short-lived session of at most one hour.');
	const allowed = allowedVariables[request.credentialProfileId], names = Object.keys(material.values).sort();
	const required = request.credentialProfileId === 's3-state-session' ? ['accessKeyId', 'secretAccessKey'] : allowed;
	if (names.some((name) => !allowed.includes(name)) || required.some((name) => !material.values[name])
		|| (request.credentialProfileId !== 's3-state-session' && names.length !== allowed.length))
		throw new Error(`Hosted infrastructure vault material for ${request.credentialProfileId} has invalid process bindings.`);
	if (material.credentialProfileId === 'opentofu-state-encryption' && !/^[a-f0-9]{64}$/u.test(material.values.key!)) throw new Error('Hosted infrastructure state encryption material must be a 32-byte hexadecimal key.');
	return material;
}

export async function resolveHostedInfrastructureVaultAuthority(workspace: HostedInfrastructureWorkspace, resolver: HostedInfrastructureVaultResolver, now = new Date()): Promise<HostedInfrastructureVaultAuthority> {
	const materials: HostedInfrastructureVaultMaterial[] = [];
	for (const request of workspace.authorities) materials.push(validateMaterial(request, await resolver(request), now));
	return { schemaVersion: 'treeseed.hosted-infrastructure-authority/v1', environment: workspace.environment, materials };
}

export function hostedInfrastructureAuthorityEnvironment(workspace: HostedInfrastructureWorkspace, authority: HostedInfrastructureVaultAuthority, root: string) {
	if (authority.schemaVersion !== 'treeseed.hosted-infrastructure-authority/v1' || authority.environment !== workspace.environment) throw new Error('Hosted infrastructure authority does not match the topology environment.');
	const expected = new Map(workspace.authorities.map((request) => [request.requestId, request])), observed = new Set<string>();
	const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: resolve(root, '.home'), TF_DATA_DIR: resolve(root, '.terraform-data'), TF_IN_AUTOMATION: 'true', TF_INPUT: '0', CHECKPOINT_DISABLE: '1' };
	for (const material of authority.materials) {
		const request = expected.get(material.requestId); if (!request || observed.has(material.requestId)) throw new Error('Hosted infrastructure authority contains unexpected or duplicate vault material.');
		validateMaterial(request, material, new Date()); observed.add(material.requestId);
		for (const [name, value] of Object.entries(processBindings(material))) {
			if (env[name] && env[name] !== value) throw new Error(`Hosted infrastructure authorities conflict for ${name}.`);
			env[name] = value;
		}
	}
	if (observed.size !== expected.size) throw new Error('Hosted infrastructure authority is incomplete.');
	return env;
}

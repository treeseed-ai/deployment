export const r2ReplicationSecretIds = {
	accountId: 'cloudflare-r2-account-id',
	managementToken: 'cloudflare-r2-management-token',
	bucketName: 'cloudflare-r2-bucket-name',
	accessKeyId: 'cloudflare-r2-access-key-id',
	secretAccessKey: 'cloudflare-r2-secret-access-key',
} as const;

export type ControlPlaneStorageEnvironment = 'production' | 'staging';

export function storageEnvironmentForRolloutGroup(rolloutGroup: string): ControlPlaneStorageEnvironment {
	return rolloutGroup.toLowerCase().includes('production') ? 'production' : 'staging';
}

export function defaultReplicationBucket(controlPlaneId: string, environment: ControlPlaneStorageEnvironment = 'production') {
	if (!controlPlaneId.trim()) throw new Error('A control-plane identity is required.');
	return environment === 'production' ? 'treeseed-library' : 'treeseed-dev-library';
}

export function addReplicationSecrets(configuration: Record<string, any>) {
	const candidate = structuredClone(configuration);
	if (!Number.isInteger(candidate.generation)) throw new Error('Host configuration generation is invalid.');
	candidate.generation += 1;
	candidate.secrets ??= {};
	for (const id of Object.values(r2ReplicationSecretIds)) {
		candidate.secrets[id] = { provider: 'file', reference: `/etc/treeseed/credentials/${id}` };
	}
	return candidate;
}

export function assertPrivateDomains(managed: any, custom: any) {
	const enabledCustomDomains = Array.isArray(custom?.domains)
		? custom.domains.filter((domain: any) => domain?.enabled === true).length
		: Array.isArray(custom) ? custom.filter((domain: any) => domain?.enabled === true).length : 0;
	if (managed?.enabled === true || enabledCustomDomains > 0) {
		throw new Error('R2 replication bucket has public domain access enabled.');
	}
	return { managedDomainEnabled: false, enabledCustomDomainCount: 0 };
}

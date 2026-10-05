import { describe, expect, it } from 'vitest';
import { addReplicationSecrets, assertPrivateDomains, defaultReplicationBucket, r2ReplicationSecretIds,
	storageEnvironmentForRolloutGroup } from '../src/cloudflare/r2-replication-provisioning.js';

describe('R2 replication provisioning', () => {
	it('creates deterministic environment buckets and manager-custodied secret references', () => {
		expect(defaultReplicationBucket('development-workstation')).toBe('treeseed-library');
		expect(defaultReplicationBucket('development-workstation', 'staging')).toBe('treeseed-dev-library');
		expect(storageEnvironmentForRolloutGroup('development-workstation')).toBe('staging');
		expect(storageEnvironmentForRolloutGroup('production')).toBe('production');
		const candidate = addReplicationSecrets({ generation: 4, secrets: {} });
		expect(candidate.generation).toBe(5);
		for (const id of Object.values(r2ReplicationSecretIds)) expect(candidate.secrets[id].reference).toBe(`/etc/treeseed/credentials/${id}`);
	});

	it('fails closed when either public access mechanism is enabled', () => {
		expect(assertPrivateDomains({ enabled: false }, { domains: [] })).toEqual({ managedDomainEnabled: false, enabledCustomDomainCount: 0 });
		expect(() => assertPrivateDomains({ enabled: true }, { domains: [] })).toThrow(/public domain/u);
		expect(() => assertPrivateDomains({ enabled: false }, { domains: [{ enabled: true }] })).toThrow(/public domain/u);
	});
});

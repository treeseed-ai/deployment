import { describe, expect, it } from 'vitest';
import { addReplicationSecrets, assertPrivateDomains, defaultReplicationBucket, r2ReplicationSecretIds } from '../src/cloudflare/r2-replication-provisioning.js';

describe('R2 replication provisioning', () => {
	it('creates a stable team bucket name and manager-custodied secret references', () => {
		expect(defaultReplicationBucket('16549507-cebc-4a16-94c5-cf91defbd6a3')).toBe('treeseed-team-16549507-library');
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

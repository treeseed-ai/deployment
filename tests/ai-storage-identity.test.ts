import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { HostConfiguration } from '@treeseed/sdk/deployment';
import { aiStoragePublicKey, prepareAiStorageIdentities, validateAiStorageTrust } from '../src/supervisor/ai/storage-identity.js';

describe('AI workload identity custody', () => {
	it('rejects private keys and oversized or malformed CA material', () => {
		for (const value of ['-----BEGIN PRIVATE KEY-----', 'invalid certificate', 'x'.repeat(65_537)]) expect(() => validateAiStorageTrust(value)).toThrow();
	});
	it('exports only the public half of an Ed25519 identity', () => {
		const keys = generateKeyPairSync('ed25519');
		const pem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
		expect(aiStoragePublicKey(pem)).toBe(keys.publicKey.export({ type: 'spki', format: 'pem' }).toString());
		expect(aiStoragePublicKey(pem)).not.toContain('PRIVATE');
	});
	it('rejects signing identities from an incompatible algorithm', () => {
		const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
		expect(() => aiStoragePublicKey(key.export({ type: 'pkcs8', format: 'pem' }).toString())).toThrow('Ed25519');
	});
	it('does not touch custody for unrelated components or an unconfigured host', () => {
		expect(prepareAiStorageIdentities({} as HostConfiguration, 'admin')).toEqual({});
		expect(prepareAiStorageIdentities({ secrets: {} } as HostConfiguration, 'api')).toEqual({});
	});
	it('rejects partial custody before writing host state', () => {
		const host = { secrets: { 'ai-inference-storage-identity': { provider: 'systemd-credential', reference: '/etc/treeseed/credentials/ai-inference-storage-identity.cred' } } };
		expect(() => prepareAiStorageIdentities(host as unknown as HostConfiguration, 'api')).toThrow('incomplete');
	});
});

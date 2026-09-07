import { generateKeyPairSync } from 'node:crypto';
import { expect, it } from 'vitest';
import { host } from './fixtures.js';
import { planManagedAiConfiguration, type ManagedAiBinding } from '../src/core/ai-configuration.js';

function securedHost() {
	const value = host();
	value.security = {
		sandbox: { required: true, runtime: 'kata-runtime-rs-qemu', brokerSocket: '/run/treeseed/sandbox.sock', modelGateway: { provider: 'openai', upstreamBaseUrl: 'https://api.openai.com', allowedModels: ['test-model'] }, profiles: [{ id: 'default', guestImage: 'example/guest', guestImageDigest: `sha256:${'a'.repeat(64)}` }] },
		providerVolume: { encryption: 'luks2', backingPath: '/var/lib/treeseed/encrypted/provider-data.luks', mountPath: '/var/lib/treeseed/agent', sizeBytes: 1_073_741_824, unlock: 'systemd-credential', recoveryRequired: true },
		applicationEncryption: { provider: 'systemd-credential', activeKeyVersion: 1, diagnosticsKeyVersion: 1 },
	};
	return value;
}
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' });
const binding: ManagedAiBinding = { nodeId: '10000000-0000-4000-8000-000000000001', teamId: '10000000-0000-4000-8000-000000000002', projectId: '10000000-0000-4000-8000-000000000003', issuer: 'https://control.example/ai', publicKeys: [{ kty: 'RSA', n: key.n!, e: key.e!, kid: 'test', alg: 'RS256', use: 'sig' }] };

it('adds public trust and sealed references, preserving other components/identity and repeating noop', () => {
	const original = securedHost(), before = JSON.stringify(original);
	const { configuration, noop } = planManagedAiConfiguration(original, binding);
	expect(noop).toBe(false); expect(JSON.stringify(original)).toBe(before);
	expect(configuration.host).toEqual(original.host); expect(configuration.components.agent).toEqual(original.components.agent);
	expect(configuration.components['ai-inference']?.configuration.secretEnvironment).toMatchObject({ AI_API_KEYS: 'ai-inference-api-keys' });
	expect(configuration.secrets['ai-inference-api-keys']).toMatchObject({ provider: 'systemd-credential' });
	expect(configuration.secrets['ai-inference-storage-identity']).toMatchObject({ provider: 'systemd-credential' });
	expect(configuration.components['ai-training']?.configuration.environment).toMatchObject({ AI_PROJECT_ID: binding.projectId,
		AI_STORAGE_SERVICE: 'training', AI_STORAGE_URL: 'https://control.example/v1/internal/ai/storage/credentials' });
	expect(planManagedAiConfiguration(configuration, binding)).toEqual({ configuration, noop: true });
	expect(() => planManagedAiConfiguration(configuration, { ...binding, nodeId: binding.teamId })).toThrow(/identity/);
});

it('rejects missing security, private keys and conflicting credential custody before mutation', () => {
	expect(() => planManagedAiConfiguration(host(), binding)).toThrow(/security/);
	expect(() => planManagedAiConfiguration(securedHost(), { ...binding, publicKeys: [{ ...binding.publicKeys[0]!, d: 'private' } as any] })).toThrow(/public RSA/);
	const original = securedHost(); original.secrets['ai-inference-api-keys'] = { provider: 'file', reference: '/etc/treeseed/credentials/ai-inference-api-keys' };
	expect(() => planManagedAiConfiguration(original, binding)).toThrow(/custody migration/);
	expect(Object.keys(original.components)).toEqual(['api', 'agent']);
});

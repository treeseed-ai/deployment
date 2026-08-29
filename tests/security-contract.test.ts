import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRecoveryBundle, verifyRecoveryBundle } from '../src/security/recovery-bundle.js';
import { providerSecuritySettings } from '../src/security/provider-volume.js';
import { verifySandboxAssignment, verifySandboxLeaseRenewal } from '../src/sandbox/trust.js';
import { sandboxAssignmentSchema, sandboxLeaseRenewalSchema } from '@treeseed/sdk/capacity-provider';
import type { HostConfiguration } from '@treeseed/sdk/deployment';

const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
	? `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);

describe('host security contracts', () => {
	it('classifies integrated development hosts by runtime environment', () => {
		const configuration = { host: { role: 'integrated' }, runtime: { environment: 'development' }, security: {
			providerVolume: { backingPath: '/work/platform/.treeseed/data/.encrypted/provider-data.luks', mountPath: '/work/platform/.treeseed/data/agent' },
		} } as unknown as HostConfiguration;
		expect(configuration.host.role).toBe('integrated');
		expect(providerSecuritySettings(configuration)).toMatchObject({ production: false, backing: expect.stringContaining('/.treeseed/data/.encrypted/provider-data.luks') });
	});

	it('authenticates recovery bundles and rejects ciphertext tampering', () => {
		const directory = mkdtempSync(resolve(tmpdir(), 'treeseed-recovery-')), path = resolve(directory, 'recovery.bundle');
		try {
			createRecoveryBundle(path, 'correct horse battery staple', { volumeRecoveryKey: 'v'.repeat(48), applicationKeks: { 'credentials-v1': 'c'.repeat(48) } });
			expect(verifyRecoveryBundle(path, 'correct horse battery staple')).toMatchObject({ authenticated: true, keyGenerations: ['credentials-v1'] });
			const value = JSON.parse(readFileSync(path, 'utf8')) as { ciphertext: string }; const replacement = value.ciphertext.endsWith('A') ? 'B' : 'A'; value.ciphertext = `${value.ciphertext.slice(0, -1)}${replacement}`; writeFileSync(path, JSON.stringify(value));
			expect(() => verifyRecoveryBundle(path, 'correct horse battery staple')).toThrow();
		} finally { rmSync(directory, { recursive: true, force: true }); }
	});

	it('accepts only assignments signed by a trusted provider key', () => {
		const directory = mkdtempSync(resolve(tmpdir(), 'treeseed-sandbox-trust-')), registry = resolve(directory, 'providers.json');
		try {
			const keys = generateKeyPairSync('ed25519'), publicJwk = keys.publicKey.export({ format: 'jwk' });
			writeFileSync(registry, JSON.stringify({ schemaVersion: 1, providers: { 'provider-test': { publicJwk: { crv: 'Ed25519', kty: 'OKP', x: publicJwk.x }, providerId: 'provider-1', teamId: 'team-1' } } }));
			const unsigned = { schemaVersion: 'treeseed.sandbox-assignment/v1', assignmentId: 'assignment-1', attempt: 1, runnerId: 'runner-1', providerId: 'provider-1', teamId: 'team-1', projectId: 'project-1', profile: 'read',
				guestImage: 'registry.example/guest', guestImageDigest: `sha256:${'a'.repeat(64)}`, identityManifestDigest: `sha256:${'b'.repeat(64)}`, contextManifestDigest: `sha256:${'c'.repeat(64)}`,
				resources: { cpuCores: 1, memoryBytes: 1_073_741_824, diskBytes: 2_147_483_648, durationSeconds: 300, processLimit: 128, outputBytes: 1_048_576 }, inputs: [], outputs: [],
				network: { defaultDeny: true, relayUrl: 'https://10.89.0.1:7443', allowedServices: ['model-gateway'] }, modelPolicy: { provider: 'openai', model: 'gpt-5.4', capabilities: ['communication'] }, credentialHandles: [], treeDxHandleIds: [], leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() };
			const assignment = sandboxAssignmentSchema.parse({ ...unsigned, signature: { keyId: 'provider-test', algorithm: 'Ed25519', value: sign(null, Buffer.from(canonical(unsigned)), keys.privateKey).toString('base64url') } });
			expect(() => verifySandboxAssignment(assignment, registry)).not.toThrow();
			expect(() => verifySandboxAssignment({ ...assignment, projectId: 'project-other' }, registry)).toThrow(/signature/u);
			const renewalUnsigned = { schemaVersion: 'treeseed.sandbox-lease-renewal/v1', sandboxId: 'sandbox-1', assignmentId: assignment.assignmentId, providerId: assignment.providerId, teamId: assignment.teamId, leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), issuedAt: new Date().toISOString() };
			const renewal = sandboxLeaseRenewalSchema.parse({ ...renewalUnsigned, signature: { keyId: 'provider-test', algorithm: 'Ed25519', value: sign(null, Buffer.from(canonical(renewalUnsigned)), keys.privateKey).toString('base64url') } });
			expect(() => verifySandboxLeaseRenewal(renewal, registry)).not.toThrow(); expect(() => verifySandboxLeaseRenewal({ ...renewal, assignmentId: 'assignment-other' }, registry)).toThrow(/signature/u);
		} finally { rmSync(directory, { recursive: true, force: true }); }
	});
});

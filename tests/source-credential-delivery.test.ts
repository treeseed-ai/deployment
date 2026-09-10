import { describe, expect, it } from 'vitest';
import type { SourceWorkspaceAuthorization } from '@treeseed/sdk/capacity-provider/sandbox';
import { createSourceCredentialRecipient, openSourceCredential, sealSourceCredential } from '../src/security/services/source-credential-delivery.js';
const now = new Date('2026-01-01T00:01:00Z');
const authorization: SourceWorkspaceAuthorization = { schemaVersion: 'treeseed.source-workspace-authorization/v1',
	id: 'source-authority', providerId: 'provider', assignmentId: 'assignment', attempt: 1,
	source: { controlPlaneId: 'api', teamId: 'team', projectId: 'project', repositoryId: 'repo', commit: 'a'.repeat(40), formatVersion: 1, profile: 'source-only' },
	mode: 'analysis', publication: 'denied', credentialBindingId: 'binding', issuedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T00:02:00Z' };
describe('source credential host delivery', () => {
	it('only opens at the exact recipient and authorization scope, never exposing plaintext in its envelope', () => {
		const recipient = createSourceCredentialRecipient(), secret = { username: 'fixture', token: 'synthetic-test-token' };
		const delivery = sealSourceCredential({ authorization, recipientPublicKey: recipient.publicKey, credential: secret }, now);
		expect(JSON.stringify(delivery)).not.toContain(secret.token);
		expect(openSourceCredential({ authorization, delivery, privateKey: recipient.privateKey }, now)).toEqual(secret);
		for (const changed of [{ ...authorization, providerId: 'other' }, { ...authorization, assignmentId: 'other' },
			{ ...authorization, source: { ...authorization.source, teamId: 'other' } }, { ...authorization, publication: 'candidate-only' as const, mode: 'work' as const }]) {
			expect(() => openSourceCredential({ authorization: changed, delivery, privateKey: recipient.privateKey }, now)).toThrow();
		}
		expect(() => openSourceCredential({ authorization, delivery, privateKey: createSourceCredentialRecipient().privateKey }, now)).toThrow();
		expect(() => openSourceCredential({ authorization, delivery, privateKey: recipient.privateKey }, new Date('2026-01-01T00:03:00Z'))).toThrow('current');
	});
});

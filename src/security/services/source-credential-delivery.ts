import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import { sourceWorkspaceAuthorizationSchema, type SourceWorkspaceAuthorization } from '@treeseed/sdk/capacity-provider/sandbox';

const prefix = Buffer.from('302a300506032b656e032100', 'hex');
const purpose = 'treeseed.source-credential-delivery/v1';
interface Credential { username: string; token: string }
interface Delivery {
	schemaVersion: typeof purpose; id: string; authorizationId: string;
	algorithm: 'x25519-hkdf-sha256-chacha20-poly1305'; ephemeralPublicKey: string;
	nonce: string; ciphertext: string; tag: string; expiresAt: string;
}
function scope(value: SourceWorkspaceAuthorization, now: Date) {
	const authorization = sourceWorkspaceAuthorizationSchema.parse(value);
	if (Date.parse(authorization.issuedAt) > now.getTime() || Date.parse(authorization.expiresAt) <= now.getTime()) throw new Error('Source credential authorization is not current.');
	return { authorization, aad: Buffer.from(JSON.stringify(authorization)) };
}
function publicKey(encoded: string) {
	if (!/^[A-Za-z0-9+/]{43}=$/u.test(encoded)) throw new Error('Invalid source credential recipient.');
	return createPublicKey({ key: Buffer.concat([prefix, Buffer.from(encoded, 'base64')]), format: 'der', type: 'spki' });
}
function credential(value: Credential) {
	if (!value || typeof value.username !== 'string' || value.username.length > 256 || typeof value.token !== 'string'
		|| !value.token || value.token.length > 8192 || /[\r\n\0]/u.test(value.username + value.token)) throw new Error('Invalid source credential.');
	return { username: value.username || 'x-access-token', token: value.token };
}
export function createSourceCredentialRecipient() {
	const pair = generateKeyPairSync('x25519');
	return { privateKey: pair.privateKey, publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64') };
}

/** Called by authorized API code after Vault resolution. Only the trusted host fetch worker can open it. */
export function sealSourceCredential(input: { authorization: SourceWorkspaceAuthorization; recipientPublicKey: string; credential: Credential }, now = new Date()): Delivery {
	const { authorization, aad } = scope(input.authorization, now), pair = createSourceCredentialRecipient(), id = randomUUID();
	const shared = diffieHellman({ privateKey: pair.privateKey, publicKey: publicKey(input.recipientPublicKey) });
	const key = Buffer.from(hkdfSync('sha256', shared, id, purpose, 32)), nonce = randomBytes(12);
	const plaintext = Buffer.from(JSON.stringify(credential(input.credential)));
	try {
		const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
		cipher.setAAD(aad, { plaintextLength: plaintext.length });
		return { schemaVersion: purpose, id, authorizationId: authorization.id, algorithm: 'x25519-hkdf-sha256-chacha20-poly1305',
			ephemeralPublicKey: pair.publicKey, nonce: nonce.toString('base64'),
			ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64'),
			tag: cipher.getAuthTag().toString('base64'), expiresAt: authorization.expiresAt };
	} finally { key.fill(0); shared.fill(0); plaintext.fill(0); }
}

/** Never call from the execution guest. Decrypted values are for one host-side Git acquisition. */
export function openSourceCredential(input: { authorization: SourceWorkspaceAuthorization; delivery: Delivery; privateKey: KeyObject }, now = new Date()): Credential {
	const { authorization, aad } = scope(input.authorization, now), delivery = input.delivery;
	if (delivery.schemaVersion !== purpose || delivery.algorithm !== 'x25519-hkdf-sha256-chacha20-poly1305'
		|| delivery.authorizationId !== authorization.id || delivery.expiresAt !== authorization.expiresAt
		|| delivery.id.length > 256 || delivery.ciphertext.length > 16384 || Buffer.from(delivery.nonce, 'base64').length !== 12
		|| Buffer.from(delivery.tag, 'base64').length !== 16) throw new Error('Source credential delivery does not match its authorization.');
	const shared = diffieHellman({ privateKey: input.privateKey, publicKey: publicKey(delivery.ephemeralPublicKey) });
	const key = Buffer.from(hkdfSync('sha256', shared, delivery.id, purpose, 32));
	let plaintext: Buffer | undefined;
	try {
		const decipher = createDecipheriv('chacha20-poly1305', key, Buffer.from(delivery.nonce, 'base64'), { authTagLength: 16 });
		decipher.setAAD(aad, { plaintextLength: Buffer.from(delivery.ciphertext, 'base64').length }); decipher.setAuthTag(Buffer.from(delivery.tag, 'base64'));
		plaintext = Buffer.concat([decipher.update(Buffer.from(delivery.ciphertext, 'base64')), decipher.final()]);
		return credential(JSON.parse(plaintext.toString('utf8')) as Credential);
	} finally { key.fill(0); shared.fill(0); plaintext?.fill(0); }
}

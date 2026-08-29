import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const bundleSchema = z.object({
	schemaVersion: z.literal('treeseed.recovery-bundle/v1'), algorithm: z.literal('aes-256-gcm'), kdf: z.object({ name: z.literal('scrypt'), salt: z.string(), N: z.literal(32768), r: z.literal(8), p: z.literal(1) }).strict(),
	nonce: z.string(), tag: z.string(), ciphertext: z.string(), createdAt: z.string().datetime(),
}).strict();

export interface RecoverySecrets { volumeRecoveryKey: string; applicationKeks: Record<string, string>; }

function target(path: string) {
	const absolute = resolve(path), parent = dirname(absolute);
	if (existsSync(absolute)) throw new Error('Recovery bundle target already exists.');
	if (!existsSync(parent) || !lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink() || realpathSync(parent) !== parent) throw new Error('Recovery bundle parent must be an existing real directory.');
	return absolute;
}

export function createRecoveryBundle(path: string, passphrase: string, secrets: RecoverySecrets) {
	const salt = randomBytes(32), nonce = randomBytes(12), key = scryptSync(passphrase, salt, 32, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
	const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(Buffer.from('treeseed.recovery-bundle/v1'));
	const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secrets)), cipher.final()]);
	const bundle = { schemaVersion: 'treeseed.recovery-bundle/v1' as const, algorithm: 'aes-256-gcm' as const,
		kdf: { name: 'scrypt' as const, salt: salt.toString('base64url'), N: 32768 as const, r: 8 as const, p: 1 as const },
		nonce: nonce.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url'), createdAt: new Date().toISOString() };
	writeFileSync(target(path), `${JSON.stringify(bundle)}\n`, { mode: 0o600, flag: 'wx' });
	return { schemaVersion: bundle.schemaVersion, createdAt: bundle.createdAt, keyGenerations: Object.keys(secrets.applicationKeks).sort() };
}

export function openRecoveryBundle(path: string, passphrase: string) {
	const bundle = bundleSchema.parse(JSON.parse(readFileSync(resolve(path), 'utf8'))), salt = Buffer.from(bundle.kdf.salt, 'base64url');
	for (const value of [bundle.kdf.salt, bundle.nonce, bundle.tag, bundle.ciphertext]) if (Buffer.from(value, 'base64url').toString('base64url') !== value) throw new Error('Recovery bundle contains a non-canonical base64url value.');
	const key = scryptSync(passphrase, salt, 32, { N: bundle.kdf.N, r: bundle.kdf.r, p: bundle.kdf.p, maxmem: 64 * 1024 * 1024 });
	const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(bundle.nonce, 'base64url')); decipher.setAAD(Buffer.from(bundle.schemaVersion)); decipher.setAuthTag(Buffer.from(bundle.tag, 'base64url'));
	const plaintext = Buffer.concat([decipher.update(Buffer.from(bundle.ciphertext, 'base64url')), decipher.final()]);
	const secrets = z.object({ volumeRecoveryKey: z.string().min(32), applicationKeks: z.record(z.string().min(32)) }).strict().parse(JSON.parse(plaintext.toString('utf8')));
	plaintext.fill(0); key.fill(0);
	return { bundle, secrets };
}

export function verifyRecoveryBundle(path: string, passphrase: string) {
	const { bundle, secrets } = openRecoveryBundle(path, passphrase);
	return { schemaVersion: bundle.schemaVersion, authenticated: true, createdAt: bundle.createdAt, keyGenerations: Object.keys(secrets.applicationKeks).sort() };
}

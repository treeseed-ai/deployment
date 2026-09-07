import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { HostConfiguration } from '@treeseed/sdk/deployment';
import { componentCredential } from '../../core/component-credential.js';
import { readComponentCredential } from '../component-sealed.js';

export const aiStorageIdentityNames = {
	inference: 'ai-inference-storage-identity', training: 'ai-training-storage-identity', lab: 'ai-lab-storage-identity',
} as const;

export function aiStoragePublicKey(privatePem: string) {
	const key = createPrivateKey(privatePem);
	if (key.asymmetricKeyType !== 'ed25519') throw new Error('AI storage requires an Ed25519 workload identity.');
	return createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
}

export function validateAiStorageTrust(content: string) {
	if (content.length > 65_536 || content.includes('PRIVATE KEY') || !new X509Certificate(content).ca) throw new Error('AI storage trust requires a public CA certificate.');
	return content;
}

/** New workload identities do not replace existing AI, provider, or artifact-signing identities. */
export function prepareAiStorageIdentities(host: HostConfiguration, componentId: string) {
	if (!['api', 'ai-inference', 'ai-training', 'ai-lab'].includes(componentId)) return {};
	const names = Object.values(aiStorageIdentityNames), configured = names.filter(id => host.secrets[id]);
	if (!configured.length) return {};
	if (configured.length !== names.length || !host.security) throw new Error('AI storage workload custody is incomplete.');
	const root = '/etc/treeseed/credentials'; mkdirSync(root, { recursive: true, mode: 0o700 });
	const metadata = lstatSync(root);
	if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o022)) throw new Error('AI storage custody directory is unsafe.');
	const ca = componentCredential(host, 'ai-storage-ca');
	if (ca.provider !== 'file') throw new Error('AI storage trust must use public certificate custody.');
	const source = '/etc/treeseed/cli/localhost-ca.crt', sourceMetadata = lstatSync(source);
	if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink() || sourceMetadata.uid !== 0 || (sourceMetadata.mode & 0o022)) throw new Error('Managed AI storage trust source is unsafe.');
	const certificate = validateAiStorageTrust(readFileSync(source, 'utf8'));
	const temporaryCa = `${ca.reference}.${randomUUID()}.new`;
	try { writeFileSync(temporaryCa, certificate, { flag: 'wx', mode: 0o600 }); renameSync(temporaryCa, ca.reference); }
	finally { if (existsSync(temporaryCa)) unlinkSync(temporaryCa); }
	const publicKeys: Record<string, string> = {};
	for (const [service, id] of Object.entries(aiStorageIdentityNames)) {
		const secret = componentCredential(host, id, `${root}/${id}`);
		if (secret.provider !== 'systemd-credential' || secret.reference !== `${root}/${id}.cred`) throw new Error('AI storage requires OS-sealed workload custody.');
		if (!existsSync(secret.reference)) {
			const key = Buffer.from(generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
			const temporary = `${secret.reference}.${randomUUID()}.new`;
			try {
				const encrypted = execFileSync('/usr/bin/systemd-creds', ['encrypt', '--with-key=host', `--name=${secret.name}`, '-', '-'],
					{ input: key, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000, maxBuffer: 65_536 });
				writeFileSync(temporary, encrypted, { flag: 'wx', mode: 0o600 }); renameSync(temporary, secret.reference);
			} catch { throw new Error('AI storage workload identity could not be initialized.'); }
			finally { key.fill(0); if (existsSync(temporary)) unlinkSync(temporary); }
		}
		publicKeys[service] = aiStoragePublicKey(readComponentCredential(host, id, `${root}/${id}`));
	}
	return publicKeys;
}

import { createPublicKey, generateKeyPairSync, randomBytes, scryptSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { HostConfiguration } from '@treeseed/sdk/deployment';
import { componentCredential } from '../core/component-credential.js';
import { ensureComponentCredential } from './component-sealed-write.js';

export const aiCredentialNames = {
	'ai-inference-postgres-password': 'ai-inference-postgres-password',
	'ai-inference-database-url': 'ai-inference-database-url',
	'ai-inference-api-keys': 'ai-inference-api-keys',
	'ai-training-postgres-password': 'ai-training-postgres-password',
	'ai-training-database-url': 'ai-training-database-url',
	'ai-training-api-keys': 'ai-training-api-keys',
	'artifact-signing-key': 'ai-artifact-signing-key',
	'artifact-source-registry': 'ai-inference-artifact-source',
	'artifact-destination-registry': 'ai-inference-artifact-destination',
	'factory-inference-key': 'ai-lab-factory-inference-key',
	'factory-training-key': 'ai-lab-factory-training-key',
	'training-ingest-key': 'ai-lab-training-ingest-key',
	'lab-library-action-key': 'ai-lab-lab-library-action-key',
	'ai-lab-api-keys': 'ai-lab-api-keys',
	'hermes-api-key': 'ai-lab-hermes-api-key',
	'hermes-session-secret': 'ai-lab-hermes-session-secret',
	'hermes-password-hash': 'ai-lab-hermes-password-hash',
} as const;
type CredentialId = keyof typeof aiCredentialNames;
export type EnsureAiCredential = (id: CredentialId, create: () => string) => string;
const random = () => randomBytes(32).toString('base64url');
const apiKey = () => `ak_${randomBytes(12).toString('hex')}_${random()}`;
const record = (key: string, scopes: string[]) => {
	const match = /^ak_([^_]+)_(.+)$/u.exec(key);
	if (!match) throw new Error('Managed AI service key is invalid.');
	const salt = randomBytes(16).toString('hex');
	return { id: match[1], hash: `scrypt:${salt}:${scryptSync(match[2]!, salt, 32).toString('hex')}`, scopes, revoked: false };
};

/** Ordered dependencies make interrupted first initialization resumable without replacing keys. */
export function provisionAiCredentialGraph(ensure: EnsureAiCredential) {
	const inference = ensure('factory-inference-key', apiKey), training = ensure('factory-training-key', apiKey);
	const ingest = ensure('training-ingest-key', apiKey), library = ensure('lab-library-action-key', apiKey);
	for (const role of ['inference', 'training'] as const) {
		const password = ensure(`ai-${role}-postgres-password`, random);
		ensure(`ai-${role}-database-url`, () => `postgresql://${role}:${encodeURIComponent(password)}@${role}-postgres:5432/${role}`);
	}
	ensure('ai-inference-api-keys', () => JSON.stringify([record(inference, ['inference:read', 'inference:invoke', 'jobs:read', 'jobs:write', 'metrics:read', 'adapters:write', 'deployments:write', 'evaluations:write'])]));
	ensure('ai-training-api-keys', () => JSON.stringify([
		record(training, ['training:read', 'training:write', 'artifacts:read', 'artifacts:write', 'datasets:read', 'datasets:write', 'jobs:read', 'jobs:write', 'libraries:read', 'libraries:write', 'libraries:train', 'metrics:read']),
		record(ingest, ['archives:write', 'documents:write', 'libraries:read', 'libraries:write', 'jobs:read']),
	]));
	ensure('ai-lab-api-keys', () => JSON.stringify([record(library, ['libraries:read', 'libraries:write', 'libraries:train'])]));
	const signing = ensure('artifact-signing-key', () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
	ensure('artifact-source-registry', () => JSON.stringify({ sourceId: 'managed-training', trustedPublicKey: createPublicKey(signing).export({ type: 'spki', format: 'pem' }).toString(), store: { backend: 'filesystem', storeId: 'managed-training', root: '/training-artifacts' } }));
	ensure('artifact-destination-registry', () => JSON.stringify({ backend: 'filesystem', storeId: 'managed-inference', root: '/artifacts' }));
	ensure('hermes-api-key', random); ensure('hermes-session-secret', random);
	ensure('hermes-password-hash', () => {
		const salt = randomBytes(16);
		return `scrypt$16384$8$1$${salt.toString('base64')}$${scryptSync(random(), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('base64')}`;
	});
}

/** Bootstrap authority is the OS credential store, never a package-owned installer or plaintext file. */
export function prepareManagedAiCredentials(host: HostConfiguration, componentId: string) {
	if (!['ai-inference', 'ai-training', 'ai-lab'].includes(componentId)) return;
	const root = '/etc/treeseed/credentials';
	// Resolve the entire graph before generating anything. Unknown or partial custody must fail closed.
	const records = Object.fromEntries(Object.entries(aiCredentialNames).map(([id, name]) => {
		const secret = componentCredential(host, id, `${root}/${name}`);
		if (secret.provider !== 'systemd-credential') throw new Error('Managed AI bootstrap requires OS-sealed credential records.');
		return [id, secret];
	}));
	const stateRoot = host.runtime.environment === 'development' ? host.runtime.dataRoot : '/var/lib/treeseed/components';
	const initialized = ['ai-inference', 'ai-training'].some(id => existsSync(`${stateRoot}/${id}/data/postgres/PG_VERSION`));
	if (initialized && Object.values(records).some(secret => !existsSync(secret.reference))) throw new Error('Managed AI state exists but its credential graph is incomplete; restore custody before activation.');
	provisionAiCredentialGraph((id, create) => ensureComponentCredential(host, id, create, `${root}/${aiCredentialNames[id]}`));
}

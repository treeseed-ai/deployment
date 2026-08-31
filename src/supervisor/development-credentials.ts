import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { HostConfiguration } from '@treeseed/sdk/deployment';

const credentialRoot = '/etc/treeseed/credentials';
const managedApiSecrets = {
	POSTGRES_PASSWORD: 'api-postgres-password',
	TREESEED_DATABASE_URL: 'api-database-url',
	SESSION_SECRET: 'api-session-secret',
	TREESEED_TREEDX_DELEGATION_PRIVATE_KEY: 'api-treedx-delegation-private-key',
	TREESEED_TREEDX_CREDENTIAL_BROKER_ASSERTION: 'treedx-credential-broker-assertion',
} as const;

export interface DevelopmentCredentialOperations {
	exists(path: string): boolean;
	read(path: string): string;
	write(path: string, value: string): void;
	random(bytes: number): string;
	privateKey(): string;
}

const operations: DevelopmentCredentialOperations = {
	exists: existsSync,
	read: (path) => readFileSync(path, 'utf8').replace(/\r?\n$/u, ''),
	write: (path, value) => {
		mkdirSync(credentialRoot, { recursive: true, mode: 0o700 });
		const temporary = `${path}.new-${randomUUID()}`;
		try { writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' }); linkSync(temporary, path); }
		finally { rmSync(temporary, { force: true }); }
	},
	random: (bytes) => randomBytes(bytes).toString('base64url'),
	privateKey: () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
};

function configuredSecretIds(host: HostConfiguration) {
	const configuration = host.components.api?.configuration;
	const configured = configuration && typeof configuration === 'object' && !Array.isArray(configuration)
		&& configuration.secretEnvironment && typeof configuration.secretEnvironment === 'object' && !Array.isArray(configuration.secretEnvironment)
		? configuration.secretEnvironment as Record<string, unknown> : {};
	for (const [name, id] of Object.entries(managedApiSecrets)) {
		if (configured[name] !== undefined && configured[name] !== id) throw new Error(`Managed development credential ${name} must use ${id}.`);
		const secret = host.secrets[id];
		if (configured[name] === id && (!secret || secret.provider !== 'file' || secret.reference !== `${credentialRoot}/${id}`)) throw new Error(`Managed development credential ${id} is outside fixed file custody.`);
	}
	return new Set<string>(Object.values(managedApiSecrets).filter((id) => Object.values(configured).includes(id)));
}

/** Creates only non-portable local service secrets, never external/provider credentials. */
export function ensureDevelopmentCredentials(host: HostConfiguration, io: DevelopmentCredentialOperations = operations) {
	if (host.runtime.environment !== 'development') return { created: [], unchanged: true };
	const configured = configuredSecretIds(host), created: string[] = [];
	const path = (id: string) => `${credentialRoot}/${id}`;
	const ensure = (id: string, value: () => string) => {
		if (!configured.has(id) || io.exists(path(id))) return;
		io.write(path(id), value()); created.push(id);
	};
	ensure(managedApiSecrets.POSTGRES_PASSWORD, () => io.random(32));
	ensure(managedApiSecrets.TREESEED_DATABASE_URL, () => {
		const passwordPath = path(managedApiSecrets.POSTGRES_PASSWORD);
		if (!io.exists(passwordPath)) throw new Error('Managed API database URL requires the local Postgres password.');
		return `postgresql://treeseed:${encodeURIComponent(io.read(passwordPath))}@database:5432/treeseed_api`;
	});
	ensure(managedApiSecrets.SESSION_SECRET, () => io.random(48));
	ensure(managedApiSecrets.TREESEED_TREEDX_DELEGATION_PRIVATE_KEY, () => io.privateKey());
	ensure(managedApiSecrets.TREESEED_TREEDX_CREDENTIAL_BROKER_ASSERTION, () => io.random(48));
	return { created: created.sort(), unchanged: created.length === 0 };
}

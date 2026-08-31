import { describe, expect, it } from 'vitest';
import { ensureDevelopmentCredentials, type DevelopmentCredentialOperations } from '../src/supervisor/development-credentials.js';
import { host } from './fixtures.js';

function configuredHost(environment: 'development' | 'production' = 'development') {
	const value = host();
	value.runtime.environment = environment;
	value.components.api!.configuration = { secretEnvironment: {
		POSTGRES_PASSWORD: 'api-postgres-password',
		TREESEED_DATABASE_URL: 'api-database-url',
		SESSION_SECRET: 'api-session-secret',
		TREESEED_TREEDX_DELEGATION_PRIVATE_KEY: 'api-treedx-delegation-private-key',
		TREESEED_TREEDX_CREDENTIAL_BROKER_ASSERTION: 'treedx-credential-broker-assertion',
	} };
	for (const id of ['api-postgres-password', 'api-database-url', 'api-session-secret', 'api-treedx-delegation-private-key', 'treedx-credential-broker-assertion']) value.secrets[id] = { provider: 'file', reference: `/etc/treeseed/credentials/${id}` };
	return value;
}

function memory() {
	const files = new Map<string, string>(), writes: string[] = [];
	const operations: DevelopmentCredentialOperations = {
		exists: (path) => files.has(path), read: (path) => files.get(path)!,
		write: (path, value) => { files.set(path, value); writes.push(path); },
		random: (bytes) => `random-${bytes}`, privateKey: () => 'private-key',
	};
	return { files, writes, operations };
}

describe('managed development credentials', () => {
	it('creates the complete local service set once and derives the database URL from the retained password', () => {
		const state = memory(), configuration = configuredHost();
		const first = ensureDevelopmentCredentials(configuration, state.operations);
		expect(first.created).toHaveLength(5);
		expect(state.files.get('/etc/treeseed/credentials/api-database-url')).toBe('postgresql://treeseed:random-32@database:5432/treeseed_api');
		expect(ensureDevelopmentCredentials(configuration, state.operations)).toEqual({ created: [], unchanged: true });
		expect(state.writes).toHaveLength(5);
	});

	it('preserves existing values and never generates credentials for production', () => {
		const state = memory(), development = configuredHost();
		state.files.set('/etc/treeseed/credentials/api-postgres-password', 'retained/value');
		ensureDevelopmentCredentials(development, state.operations);
		expect(state.files.get('/etc/treeseed/credentials/api-postgres-password')).toBe('retained/value');
		expect(state.files.get('/etc/treeseed/credentials/api-database-url')).toBe('postgresql://treeseed:retained%2Fvalue@database:5432/treeseed_api');
		const production = memory();
		expect(ensureDevelopmentCredentials(configuredHost('production'), production.operations)).toEqual({ created: [], unchanged: true });
		expect(production.writes).toEqual([]);
	});

	it('rejects noncanonical or external custody instead of writing', () => {
		const configuration = configuredHost(), state = memory();
		(configuration.components.api!.configuration!.secretEnvironment as Record<string, string>).POSTGRES_PASSWORD = 'other-password';
		expect(() => ensureDevelopmentCredentials(configuration, state.operations)).toThrow(/must use api-postgres-password/u);
		expect(state.writes).toEqual([]);
	});
});

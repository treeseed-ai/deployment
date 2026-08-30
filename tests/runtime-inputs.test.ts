import { describe, expect, it } from 'vitest';
import { componentActivationInputs, managedHostRuntimeEnvironment, managedRuntimeInputEnvironment, prepareComponentSecretFiles, restoreComponentSecretFiles, type SecretFileOperations } from '../src/index.js';
import { component, host } from './fixtures.js';

describe('component runtime input custody', () => {
	it('renders declared inputs without reading secrets', () => {
		const configuration = host(), release = component('ai-lab', 'development', 'd');
		release.runtime.configuration = {
			environment: [{ name: 'BASE_MODEL_REVISION', required: true, source: 'configuration', default: 'immutable-base' }, { name: 'RUNTIME_GID', required: true, source: 'manager' }],
			secretEnvironment: [{ name: 'AI_LAB_API_KEYS', required: true }],
			secretFiles: [{ id: 'ai-lab-hermes-api-key', path: '/etc/treeseed/credentials/ai-lab-hermes-api-key', required: true }, { id: 'ai-lab-training-source', path: '/etc/treeseed/credentials/ai-lab-training-source', required: true }], files: [],
		};
		configuration.components['ai-lab'] = { enabled: true, track: 'development', aliases: {}, connections: {}, configuration: { secretEnvironment: { AI_LAB_API_KEYS: 'ai-lab-api-keys' } } } as any;
		for (const id of ['ai-lab-api-keys', 'ai-lab-hermes-api-key', 'ai-lab-training-source']) configuration.secrets[id] = { provider: 'file', reference: `/etc/treeseed/credentials/${id}` };
		const result = managedRuntimeInputEnvironment(configuration, release, { runtimeGid: () => 994 });
		expect(result).toEqual({ BASE_MODEL_REVISION: 'immutable-base', RUNTIME_GID: '994' });
		expect(JSON.stringify(result)).not.toContain('ai-lab-api-keys');
	});

	it('fails closed on missing or undeclared runtime input custody', () => {
		const configuration = host(), release = component('ai-training', 'development', 'e');
		release.runtime.configuration = { environment: [{ name: 'ARTIFACT_BACKEND', required: false, source: 'configuration', default: 'filesystem' }], secretEnvironment: [{ name: 'TRAINING_DATABASE_URL', required: true }], secretFiles: [{ id: 'ai-artifact-signing-key', path: '/etc/treeseed/credentials/ai-artifact-signing-key', required: true }], files: [] };
		configuration.components['ai-training'] = { enabled: true, track: 'development', aliases: {}, connections: {}, configuration: {} } as any;
		expect(() => managedRuntimeInputEnvironment(configuration, release, { runtimeGid: () => 1 })).toThrow(/TRAINING_DATABASE_URL/u);
		configuration.components['ai-training']!.configuration = { secretEnvironment: { TRAINING_DATABASE_URL: 'training-database-url' }, environment: { UNDECLARED: 'value' } };
		configuration.secrets['training-database-url'] = { provider: 'file', reference: '/etc/treeseed/credentials/training-database-url' };
		configuration.secrets['ai-artifact-signing-key'] = { provider: 'file', reference: '/etc/treeseed/credentials/ai-artifact-signing-key' };
		expect(() => managedRuntimeInputEnvironment(configuration, release, { runtimeGid: () => 1 })).toThrow(/undeclared inputs/u);
		delete (configuration.components['ai-training']!.configuration as any).environment;
		configuration.secrets['training-database-url'] = { provider: 'file', reference: '/etc/treeseed/credentials/wrong-path' };
		expect(() => managedRuntimeInputEnvironment(configuration, release, { runtimeGid: () => 1 })).toThrow(/declared custody path/u);
	});

	it('preserves legacy components with no declared runtime inputs', () => {
		const configuration = host();
		configuration.components.api!.configuration = { environment: { NODE_ENV: 'production' }, secretEnvironment: { DATABASE_URL: 'api-database' }, files: { 'policy.json': '{}' } };
		expect(managedRuntimeInputEnvironment(configuration, component('api', 'stable', 'a'))).toEqual({});
	});

	it('accepts a fixed activation value for a declared manager-derived input', () => {
		const configuration = host(), release = component('ai-lab', 'development', 'b');
		release.runtime.configuration = { environment: [{ name: 'TREESEED_AI_MODE_URL', required: true, source: 'manager' }], secretEnvironment: [], secretFiles: [], files: [] };
		configuration.components['ai-lab'] = { enabled: true, track: 'development', aliases: {}, connections: {}, configuration: {} } as any;
		expect(managedRuntimeInputEnvironment(configuration, release, { runtimeGid: () => 1000 }, { TREESEED_AI_MODE_URL: 'https://host.docker.internal:4790/v1/ai/mode' })).toEqual({});
	});

	it('prepares the mode controller environment before privileged activation', () => {
		const configuration = host(), release = component('ai-lab', 'development', 'b');
		release.runtime.modeControl = { role: 'controller', resource: 'ai-gpu', states: ['awake', 'sleep'] } as any;
		release.runtime.configuration = { environment: [{ name: 'TREESEED_AI_MODE_URL', required: true, source: 'manager' }], secretEnvironment: [], secretFiles: [], files: [] };
		configuration.components['ai-lab'] = { enabled: true, track: 'development', aliases: {}, connections: {}, configuration: {} } as any;
		expect(componentActivationInputs(configuration, release, [release]).connectionEnvironment).toMatchObject({
			TREESEED_AI_MODE_URL: 'https://host.docker.internal:4790/v1/ai/mode',
			TREESEED_AI_MODE_CA_FILE: '/run/secrets/ai-mode-ca',
		});
	});

	it('binds the Agent container to the root broker group without hard-coding a host gid', () => {
		expect(managedHostRuntimeEnvironment('agent', { sandboxBrokerGid: () => 987 }))
			.toEqual({ TREESEED_SANDBOX_BROKER_GID: '987' });
		expect(managedHostRuntimeEnvironment('api', { sandboxBrokerGid: () => { throw new Error('must not inspect broker'); } }))
			.toEqual({});
	});

	it('validates every fixed file before mutation and restores temporary custody', () => {
		const configuration = host(), secured: Array<[string, number]> = [], restored: string[] = [];
		configuration.secrets['hermes-key'] = { provider: 'file', reference: '/etc/treeseed/credentials/hermes-key' };
		configuration.secrets['session-key'] = { provider: 'file', reference: '/etc/treeseed/credentials/session-key' };
		let receipt: any;
		const operations: SecretFileOperations = {
			runtimeGid: () => 991,
			inspect: () => ({ uid: 0, gid: 0, mode: 0o100600, isFile: () => true, isSymbolicLink: () => false }),
			secure: (path, gid) => secured.push([path, gid]), restore: (path) => restored.push(path),
			load: () => receipt, save: (value) => { receipt = value; }, remove: () => { receipt = undefined; },
		};
		expect(prepareComponentSecretFiles(configuration, 'ai-lab', ['hermes-key'], operations)).toEqual(['hermes-key']);
		expect(secured).toEqual([['/etc/treeseed/credentials/hermes-key', 991]]);
		expect(restoreComponentSecretFiles('ai-lab', operations)).toEqual(['hermes-key']);
		expect(restored).toEqual(['/etc/treeseed/credentials/hermes-key']);
		expect(receipt).toBeUndefined();

		secured.length = 0;
		operations.inspect = (path) => ({ uid: 0, gid: 0, mode: 0o100600, isFile: () => true, isSymbolicLink: () => path.endsWith('session-key') });
		expect(() => prepareComponentSecretFiles(configuration, 'ai-lab', ['hermes-key', 'session-key'], operations)).toThrow(/regular file/u);
		expect(secured).toEqual([]);
		configuration.secrets.outside = { provider: 'file', reference: '/tmp/outside' };
		expect(() => prepareComponentSecretFiles(configuration, 'ai-lab', ['outside'], operations)).toThrow(/outside fixed file custody/u);
	});

	it('rolls back earlier permission changes when a later secure operation fails', () => {
		const configuration = host(), restored: string[] = [];
		for (const id of ['first', 'second']) configuration.secrets[id] = { provider: 'file', reference: `/etc/treeseed/credentials/${id}` };
		let receipt: any;
		const operations: SecretFileOperations = {
			runtimeGid: () => 991, inspect: () => ({ uid: 0, gid: 0, mode: 0o100600, isFile: () => true, isSymbolicLink: () => false }),
			secure: (path) => { if (path.endsWith('/second')) throw new Error('permission failure'); },
			restore: (path) => restored.push(path), load: () => receipt, save: (value) => { receipt = value; }, remove: () => { receipt = undefined; },
		};
		expect(() => prepareComponentSecretFiles(configuration, 'ai-lab', ['first', 'second'], operations)).toThrow(/permission failure/u);
		expect(restored).toEqual(['/etc/treeseed/credentials/first', '/etc/treeseed/credentials/second']);
		expect(receipt).toBeUndefined();
	});
});

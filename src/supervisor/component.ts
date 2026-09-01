import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { HostConfiguration } from '@treeseed/sdk/deployment';
import { loadHostConfiguration } from '../core/configuration.js';
import { managedHostRuntimeEnvironment } from './host-runtime.js';

const environmentKey = /^[A-Z][A-Z0-9_]{0,127}$/u;
const fileName = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const credentialPath = /^\/etc\/treeseed\/credentials\/[a-z0-9][a-z0-9._-]{0,127}$/u;
const stateDirectories: Record<string, string[]> = {
	api: ['postgres', 'operations-runner'],
	admin: [],
	agent: [],
	treedx: ['data'],
	lab: ['data'],
	'ai-inference': ['data/postgres', 'data/models', 'data/inference'],
	'ai-training': ['data/postgres', 'data/training', 'data/archive', 'data/models'],
	'ai-lab': ['data/state', 'data/hermes', 'data/workspace', 'data/open-webui'],
};
type SecretReader = (path: string) => string;

export function componentStateDirectories(componentId: string) {
	const directories = stateDirectories[componentId];
	if (!directories) throw new Error(`Unsupported configured component ${componentId}.`);
	return [...directories];
}

export function componentStateRoot(host: HostConfiguration, componentId: string) {
	if (componentId === 'agent' && host.security) return resolve(host.security.providerVolume.mountPath);
	const root = host.runtime.environment === 'development' ? host.runtime.dataRoot : '/var/lib/treeseed/components';
	if (!root || !root.startsWith('/') || root === '/' || root === '/home' || root === '/var') throw new Error('Configured component data root is unsafe.');
	return resolve(root, componentId);
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (value === undefined) return {};
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
	return value as Record<string, unknown>;
}

export function resolveDevelopmentSecretEnvironment(host: HostConfiguration, componentId: string, requested: Record<string, string>, connectionEnvironment: Record<string, string> = {}, readSecret: SecretReader = (path) => readFileSync(path, 'utf8')) {
	const selection = host.components[componentId];
	if (!selection) throw new Error(`Unknown configured component ${componentId}.`);
	const configuration = record(selection.configuration, 'Component configuration');
	const environment = record(configuration.environment, 'Component environment');
	const configured = record(configuration.secretEnvironment, 'Component secret environment');
	const values: Record<string, string> = { ...connectionEnvironment };
	for (const [key, value] of Object.entries(environment)) {
		if (!environmentKey.test(key) || typeof value !== 'string' || value.length > 16_384) throw new Error(`Invalid environment entry ${key}.`);
		// Manager-owned development connections deliberately supersede the
		// released component's static peer URL for the lifetime of the lease.
		values[key] ??= value;
	}
	for (const [key, secretId] of Object.entries(requested).sort(([left], [right]) => left.localeCompare(right))) {
		if (!environmentKey.test(key) || !fileName.test(secretId)) throw new Error(`Invalid development secret entry ${key}.`);
		if (configured[key] !== secretId) throw new Error(`Development secret ${key} is not configured for component ${componentId}.`);
		if (values[key] !== undefined) throw new Error(`Development secret ${key} conflicts with a managed or configured environment entry.`);
		const secret = host.secrets[secretId];
		if (!secret || secret.provider !== 'file' || secret.reference !== `/etc/treeseed/credentials/${secretId}`) throw new Error(`Secret ${secretId} is not available through v1 file custody.`);
		const value = readSecret(secret.reference).replace(/\r?\n$/u, '');
		if (value.length > 16_384) throw new Error(`Development secret ${key} exceeds the environment limit.`);
		values[key] = value;
	}
	if (host.runtime.environment === 'development') {
		values.TREESEED_ENVIRONMENT ??= 'local';
		values.TREESEED_LOCAL_DEV_MODE ??= '1';
		values.LOCAL_DEV_MODE ??= '1';
		values.TREESEED_COMPONENT_DATA_ROOT = host.runtime.dataRoot!;
	}
	return values;
}

export function renderComponentEnvironment(host: HostConfiguration, componentId: string, connectionEnvironment: Record<string, string> = {}, readSecret: SecretReader = (path) => readFileSync(path, 'utf8'), optionalSecretEnvironment: readonly string[] = []) {
	const selection = host.components[componentId];
	if (!selection) throw new Error(`Unknown configured component ${componentId}.`);
	const configuration = record(selection.configuration, 'Component configuration');
	const environment = record(configuration.environment, 'Component environment');
	const secretEnvironment = record(configuration.secretEnvironment, 'Component secret environment');
	const optional = new Set(optionalSecretEnvironment);
	const values = new Map<string, string>(Object.entries(connectionEnvironment));
	for (const [key, value] of Object.entries(environment)) {
		if (!environmentKey.test(key) || typeof value !== 'string' || value.length > 16_384) throw new Error(`Invalid environment entry ${key}.`);
		if (values.has(key)) throw new Error(`Environment entry ${key} is reserved for a managed connection.`);
		values.set(key, value);
	}
	for (const [key, secretId] of Object.entries(secretEnvironment)) {
		if (!environmentKey.test(key) || typeof secretId !== 'string') throw new Error(`Invalid secret environment entry ${key}.`);
		const secret = host.secrets[secretId];
		if (!secret || secret.provider !== 'file' || secret.reference !== `/etc/treeseed/credentials/${secretId}`) throw new Error(`Secret ${secretId} is not available through v1 file custody.`);
		try { values.set(key, readSecret(secret.reference).replace(/\r?\n$/u, '')); }
		catch (error) {
			if (optional.has(key) && error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
			throw error;
		}
	}
	if (host.runtime.environment === 'development') {
		if (!values.has('TREESEED_ENVIRONMENT')) values.set('TREESEED_ENVIRONMENT', 'local');
		if (!values.has('TREESEED_LOCAL_DEV_MODE')) values.set('TREESEED_LOCAL_DEV_MODE', '1');
		if (!values.has('LOCAL_DEV_MODE')) values.set('LOCAL_DEV_MODE', '1');
		values.set('TREESEED_COMPONENT_DATA_ROOT', host.runtime.dataRoot!);
	}
	if (componentId === 'agent') values.set('TREESEED_COMPONENT_DATA_ROOT', componentStateRoot(host, componentId));
	return [...values].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + (values.size ? '\n' : '');
}

function atomicText(path: string, value: string, mode = 0o600) {
	const temporary = `${path}.new`;
	writeFileSync(temporary, value, { mode });
	renameSync(temporary, path);
}

export interface SecretFileOperations {
	runtimeGid(): number;
	inspect(path: string): { uid: number; gid: number; mode: number; isFile(): boolean; isSymbolicLink(): boolean };
	secure(path: string, gid: number): void;
	restore(path: string, uid: number, gid: number, mode: number): void;
	load(componentId: string): SecretCustodyReceipt | undefined;
	save(receipt: SecretCustodyReceipt): void;
	remove(componentId: string): void;
	removeRuntime?(componentId: string): void;
}

interface SecretCustodyReceipt { componentId: string; files: Array<{ id: string; path: string; uid: number; gid: number; mode: number }> }
const secretCustodyRoot = '/var/lib/treeseed/secret-custody';

const secretFileOperations: SecretFileOperations = {
	runtimeGid: () => statSync('/var/lib/treeseed/component-secrets').gid,
	inspect: (path) => lstatSync(path),
	secure: (path, gid) => { chownSync(path, 0, gid); chmodSync(path, 0o640); },
	restore: (path, uid, gid, mode) => { chownSync(path, uid, gid); chmodSync(path, mode); },
	load: (componentId) => {
		const path = resolve(secretCustodyRoot, `${componentId}.json`);
		return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as SecretCustodyReceipt : undefined;
	},
	save: (receipt) => { mkdirSync(secretCustodyRoot, { recursive: true, mode: 0o700 }); atomicText(resolve(secretCustodyRoot, `${receipt.componentId}.json`), `${JSON.stringify(receipt)}\n`); },
	remove: (componentId) => { const path = resolve(secretCustodyRoot, `${componentId}.json`); if (existsSync(path)) unlinkSync(path); },
	removeRuntime: (componentId) => { rmSync(`/run/treeseed/component-credentials/${componentId}`, { recursive: true, force: true }); },
};

export function restoreComponentSecretFiles(componentId: string, operations: SecretFileOperations = secretFileOperations) {
	if (!/^[a-z][a-z0-9.-]+$/u.test(componentId)) throw new Error('Invalid component secret-custody identity.');
	const receipt = operations.load(componentId);
	if (!receipt) { operations.removeRuntime?.(componentId); return []; }
	for (const file of receipt.files) operations.restore(file.path, file.uid, file.gid, file.mode);
	operations.remove(componentId);
	operations.removeRuntime?.(componentId);
	return receipt.files.map(({ id }) => id);
}

function materializeApplicationKeys(host: HostConfiguration, componentId: string) {
	if (!host.security || !['agent', 'api'].includes(componentId)) return [];
	const generations = componentId === 'agent'
		? [{ purpose: 'credentials', version: host.security.applicationEncryption.activeKeyVersion }]
		: [{ purpose: 'credentials', version: host.security.applicationEncryption.activeKeyVersion }, { purpose: 'diagnostics', version: host.security.applicationEncryption.diagnosticsKeyVersion }];
	const root = `/run/treeseed/component-credentials/${componentId}`; mkdirSync(root, { recursive: true, mode: 0o700 });
	const materialized: Array<{ purpose: string; version: number; target: string; active: boolean }> = [];
	for (const { purpose, version } of generations) {
		const credential = `application-${purpose === 'credentials' ? 'credential' : 'diagnostics'}-kek-v${version}`, source = `/etc/treeseed/credentials/${credential}.cred`, target = resolve(root, purpose);
		if (!existsSync(source)) throw new Error(`Encrypted ${purpose} key generation ${version} is unavailable.`);
		const plaintext = execFileSync('/usr/bin/systemd-creds', ['decrypt', `--name=${credential}`, source, '-']);
		try { replaceRuntimeCredential(target, plaintext); }
		finally { plaintext.fill(0); }
		materialized.push({ purpose, version, target, active: true });
		const prefix = `application-${purpose === 'credentials' ? 'credential' : 'diagnostics'}-kek-v`;
		for (const name of readdirSync('/etc/treeseed/credentials').filter((name) => name.startsWith(prefix) && name.endsWith('.cred'))) {
			const priorVersion = Number(name.slice(prefix.length, -5)); if (!Number.isInteger(priorVersion) || priorVersion < 1 || priorVersion >= version) continue;
			const priorTarget = resolve(root, `${purpose}-v${priorVersion}`), prior = execFileSync('/usr/bin/systemd-creds', ['decrypt', `--name=${prefix}${priorVersion}`, `/etc/treeseed/credentials/${name}`, '-']);
			try { replaceRuntimeCredential(priorTarget, prior); } finally { prior.fill(0); }
			materialized.push({ purpose, version: priorVersion, target: priorTarget, active: false });
		}
	}
	return materialized;
}

/** Atomically refresh an ephemeral credential so reconciliation and rollback are idempotent. */
export function replaceRuntimeCredential(target: string, plaintext: Buffer, ownership = { uid: 65_532, gid: 65_532 }) {
	const temporary = `${target}.tmp-${randomUUID()}`;
	try {
		writeFileSync(temporary, plaintext, { mode: 0o400, flag: 'wx' });
		chownSync(temporary, ownership.uid, ownership.gid);
		chmodSync(temporary, 0o400);
		renameSync(temporary, target);
	} finally {
		if (existsSync(temporary)) rmSync(temporary, { force: true });
	}
}

export function prepareComponentSecretFiles(host: HostConfiguration, componentId: string, secretFileIds: readonly string[], operations: SecretFileOperations = secretFileOperations) {
	if (!/^[a-z][a-z0-9.-]+$/u.test(componentId)) throw new Error('Invalid component secret-custody identity.');
	const gid = operations.runtimeGid();
	const files = [...secretFileIds].sort().map((secretId) => {
		if (!fileName.test(secretId)) throw new Error(`Invalid component secret ${secretId}.`);
		const secret = host.secrets[secretId];
		if (!secret || secret.provider !== 'file' || !credentialPath.test(secret.reference)) throw new Error(`Component secret ${secretId} is outside fixed file custody.`);
		const metadata = operations.inspect(secret.reference);
		if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Component secret ${secretId} must be a regular file.`);
		return { id: secretId, path: secret.reference, uid: metadata.uid, gid: metadata.gid, mode: metadata.mode & 0o7777 };
	});
	const existing = operations.load(componentId);
	if (existing && JSON.stringify(existing.files.map(({ id, path }) => ({ id, path }))) !== JSON.stringify(files.map(({ id, path }) => ({ id, path })))) throw new Error(`Component ${componentId} fixed secret custody changed while active.`);
	const receipt = existing ?? { componentId, files };
	if (!existing) operations.save(receipt);
	try {
		for (const file of files) operations.secure(file.path, gid);
	} catch (error) {
		for (const file of receipt.files) operations.restore(file.path, file.uid, file.gid, file.mode);
		operations.remove(componentId);
		throw error;
	}
	return files.map(({ id }) => id);
}

export function bindSandboxGuestImageDigest(componentId: string, name: string, value: string, digest?: string) {
	if (!digest || componentId !== 'agent' || name !== 'treeseed.capacity-provider.yaml') return value;
	let replacements = 0;
	const bound = value.replace(/^([ \t]*(?:-[ \t]+)?guestImageDigest:[ \t]*)sha256:[a-f0-9]{64}[ \t]*$/gmu, (_line, prefix: string) => { replacements += 1; return `${prefix}${digest}`; });
	if (replacements === 0) throw new Error('Managed agent manifest does not declare a sandbox guest image digest.');
	return bound;
}

export function configuredSandboxGuestImageDigests(manifestPath = '/etc/treeseed/components/agent/treeseed.capacity-provider.yaml') {
	if (!existsSync(manifestPath)) return [];
	return [...readFileSync(manifestPath, 'utf8').matchAll(/^[ \t]*(?:-[ \t]+)?guestImageDigest:[ \t]*(sha256:[a-f0-9]{64})[ \t]*$/gmu)].map((match) => match[1]!);
}

export function configureComponent(componentId: string, connectionEnvironment: Record<string, string> = {}, secretFileIds: readonly string[] = [], optionalSecretEnvironment: readonly string[] = [], sandboxGuestImageDigest?: string) {
	const host = loadHostConfiguration(), selection = host.components[componentId];
	if (!selection) throw new Error(`Unsupported configured component ${componentId}.`);
	Object.assign(connectionEnvironment, managedHostRuntimeEnvironment(componentId));
	const directories = componentStateDirectories(componentId);
	const configurationRoot = `/etc/treeseed/components/${componentId}`, stateRoot = componentStateRoot(host, componentId);
	if (host.security && componentId === 'api') Object.assign(connectionEnvironment, { TREESEED_CAPACITY_ENCRYPTION_KEY_VERSION: String(host.security.applicationEncryption.activeKeyVersion), TREESEED_DIAGNOSTICS_KEY_VERSION: String(host.security.applicationEncryption.diagnosticsKeyVersion) });
	if (host.security && componentId === 'agent') Object.assign(connectionEnvironment, { TREESEED_PROVIDER_CREDENTIAL_KEY_VERSION: String(host.security.applicationEncryption.activeKeyVersion) });
	mkdirSync(configurationRoot, { recursive: true, mode: 0o700 });
	mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
	if (componentId === 'agent') { chownSync(stateRoot, 65_532, 65_532); chmodSync(stateRoot, 0o700); }
	if (componentId === 'agent' && existsSync('/etc/treeseed/sandbox/relay-ca.crt')) chmodSync('/etc/treeseed/sandbox/relay-ca.crt', 0o644);
	const applicationKeys = materializeApplicationKeys(host, componentId);
	if (componentId === 'api') {
		const credentials = applicationKeys.filter((entry) => entry.purpose === 'credentials' && !entry.active).map((entry) => `${entry.version}:/run/treeseed-keys/credentials-v${entry.version}`).join(',');
		const diagnostics = applicationKeys.filter((entry) => entry.purpose === 'diagnostics' && !entry.active).map((entry) => `${entry.version}:/run/treeseed-keys/diagnostics-v${entry.version}`).join(',');
		if (credentials) connectionEnvironment.TREESEED_CAPACITY_HISTORICAL_KEY_FILES = credentials; if (diagnostics) connectionEnvironment.TREESEED_DIAGNOSTICS_HISTORICAL_KEY_FILES = diagnostics;
	}
	if (componentId === 'agent') { const historical = applicationKeys.filter((entry) => !entry.active).map((entry) => `${entry.version}:/run/credentials/credentials-v${entry.version}`).join(','); if (historical) connectionEnvironment.TREESEED_PROVIDER_CREDENTIAL_HISTORICAL_KEY_FILES = historical; }
	for (const name of directories) mkdirSync(resolve(stateRoot, name), { recursive: true, mode: 0o700 });
	const secretFiles = prepareComponentSecretFiles(host, componentId, secretFileIds);
	let files: Record<string, unknown>;
	try {
		atomicText(resolve(configurationRoot, 'environment'), renderComponentEnvironment(host, componentId, connectionEnvironment, undefined, optionalSecretEnvironment));
		files = record(record(selection.configuration, 'Component configuration').files, 'Component files');
		for (const [name, value] of Object.entries(files)) {
			if (!fileName.test(name) || typeof value !== 'string' || value.length > 1_048_576) throw new Error(`Invalid managed component file ${name}.`);
			const target = resolve(configurationRoot, name);
			atomicText(target, bindSandboxGuestImageDigest(componentId, name, value, sandboxGuestImageDigest));
			if (componentId === 'agent') { chownSync(target, 0, 65_532); chmodSync(target, 0o640); }
		}
	} catch (error) { restoreComponentSecretFiles(componentId); throw error; }
	return { componentId, configured: true, environmentKeys: Object.keys(record(record(selection.configuration, 'Component configuration').environment, 'Component environment')).length + Object.keys(record(record(selection.configuration, 'Component configuration').secretEnvironment, 'Component secret environment')).length, files: Object.keys(files).sort(), secretFiles };
}

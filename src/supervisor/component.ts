import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { HostConfiguration } from '@treeseed/sdk/deployment';
import { loadHostConfiguration } from '../core/configuration.js';

const environmentKey = /^[A-Z][A-Z0-9_]{0,127}$/u;
const fileName = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const stateDirectories: Record<string, string[]> = { api: ['postgres', 'operations-runner'], admin: [], agent: [], treedx: ['data'], ai: ['data/models', 'data/inference', 'data/training', 'data/archive'], lab: ['data'] };
type SecretReader = (path: string) => string;

export function componentStateRoot(host: HostConfiguration, componentId: string) {
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
		if (values[key] !== undefined) throw new Error(`Environment entry ${key} is reserved for a managed connection.`);
		values[key] = value;
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

export function renderComponentEnvironment(host: HostConfiguration, componentId: string, connectionEnvironment: Record<string, string> = {}) {
	const selection = host.components[componentId];
	if (!selection) throw new Error(`Unknown configured component ${componentId}.`);
	const configuration = record(selection.configuration, 'Component configuration');
	const environment = record(configuration.environment, 'Component environment');
	const secretEnvironment = record(configuration.secretEnvironment, 'Component secret environment');
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
		values.set(key, readFileSync(secret.reference, 'utf8').replace(/\r?\n$/u, ''));
	}
	if (host.runtime.environment === 'development') {
		if (!values.has('TREESEED_ENVIRONMENT')) values.set('TREESEED_ENVIRONMENT', 'local');
		if (!values.has('TREESEED_LOCAL_DEV_MODE')) values.set('TREESEED_LOCAL_DEV_MODE', '1');
		if (!values.has('LOCAL_DEV_MODE')) values.set('LOCAL_DEV_MODE', '1');
		values.set('TREESEED_COMPONENT_DATA_ROOT', host.runtime.dataRoot!);
	}
	return [...values].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + (values.size ? '\n' : '');
}

function atomicText(path: string, value: string, mode = 0o600) {
	const temporary = `${path}.new`;
	writeFileSync(temporary, value, { mode });
	renameSync(temporary, path);
}

export function configureComponent(componentId: string, connectionEnvironment: Record<string, string> = {}) {
	const host = loadHostConfiguration(), selection = host.components[componentId];
	if (!selection || !(componentId in stateDirectories)) throw new Error(`Unsupported configured component ${componentId}.`);
	const configurationRoot = `/etc/treeseed/components/${componentId}`, stateRoot = componentStateRoot(host, componentId);
	mkdirSync(configurationRoot, { recursive: true, mode: 0o700 });
	mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
	for (const name of stateDirectories[componentId]!) mkdirSync(resolve(stateRoot, name), { recursive: true, mode: 0o700 });
	atomicText(resolve(configurationRoot, 'environment'), renderComponentEnvironment(host, componentId, connectionEnvironment));
	const files = record(record(selection.configuration, 'Component configuration').files, 'Component files');
	for (const [name, value] of Object.entries(files)) {
		if (!fileName.test(name) || typeof value !== 'string' || value.length > 1_048_576) throw new Error(`Invalid managed component file ${name}.`);
		atomicText(resolve(configurationRoot, name), value);
	}
	return { componentId, configured: true, environmentKeys: Object.keys(record(record(selection.configuration, 'Component configuration').environment, 'Component environment')).length + Object.keys(record(record(selection.configuration, 'Component configuration').secretEnvironment, 'Component secret environment')).length, files: Object.keys(files).sort() };
}

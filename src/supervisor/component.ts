import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { HostConfiguration } from '@treeseed/sdk/deployment';
import { loadHostConfiguration } from '../core/configuration.js';

const environmentKey = /^[A-Z][A-Z0-9_]{0,127}$/u;
const fileName = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const stateDirectories: Record<string, string[]> = { api: ['postgres', 'operations-runner'], agent: [], treedx: ['data'], ai: ['data'], lab: ['data'] };

function record(value: unknown, label: string): Record<string, unknown> {
	if (value === undefined) return {};
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
	return value as Record<string, unknown>;
}

export function renderComponentEnvironment(host: HostConfiguration, componentId: string) {
	const selection = host.components[componentId];
	if (!selection) throw new Error(`Unknown configured component ${componentId}.`);
	const configuration = record(selection.configuration, 'Component configuration');
	const environment = record(configuration.environment, 'Component environment');
	const secretEnvironment = record(configuration.secretEnvironment, 'Component secret environment');
	const values = new Map<string, string>();
	for (const [key, value] of Object.entries(environment)) {
		if (!environmentKey.test(key) || typeof value !== 'string' || value.length > 16_384) throw new Error(`Invalid environment entry ${key}.`);
		values.set(key, value);
	}
	for (const [key, secretId] of Object.entries(secretEnvironment)) {
		if (!environmentKey.test(key) || typeof secretId !== 'string') throw new Error(`Invalid secret environment entry ${key}.`);
		const secret = host.secrets[secretId];
		if (!secret || secret.provider !== 'file' || secret.reference !== `/etc/treeseed/credentials/${secretId}`) throw new Error(`Secret ${secretId} is not available through v1 file custody.`);
		values.set(key, readFileSync(secret.reference, 'utf8').replace(/\r?\n$/u, ''));
	}
	return [...values].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + (values.size ? '\n' : '');
}

function atomicText(path: string, value: string, mode = 0o600) {
	const temporary = `${path}.new`;
	writeFileSync(temporary, value, { mode });
	renameSync(temporary, path);
}

export function configureComponent(componentId: string) {
	const host = loadHostConfiguration(), selection = host.components[componentId];
	if (!selection || !(componentId in stateDirectories)) throw new Error(`Unsupported configured component ${componentId}.`);
	const configurationRoot = `/etc/treeseed/components/${componentId}`, stateRoot = `/var/lib/treeseed/components/${componentId}`;
	mkdirSync(configurationRoot, { recursive: true, mode: 0o700 });
	mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
	for (const name of stateDirectories[componentId]!) mkdirSync(resolve(stateRoot, name), { recursive: true, mode: 0o700 });
	atomicText(resolve(configurationRoot, 'environment'), renderComponentEnvironment(host, componentId));
	const files = record(record(selection.configuration, 'Component configuration').files, 'Component files');
	for (const [name, value] of Object.entries(files)) {
		if (!fileName.test(name) || typeof value !== 'string' || value.length > 1_048_576) throw new Error(`Invalid managed component file ${name}.`);
		atomicText(resolve(configurationRoot, name), value);
	}
	return { componentId, configured: true, environmentKeys: Object.keys(record(record(selection.configuration, 'Component configuration').environment, 'Component environment')).length + Object.keys(record(record(selection.configuration, 'Component configuration').secretEnvironment, 'Component secret environment')).length, files: Object.keys(files).sort() };
}

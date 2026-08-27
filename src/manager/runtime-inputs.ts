import { statSync } from 'node:fs';
import type { ComponentRelease, HostConfiguration } from '@treeseed/sdk/deployment';

const componentConfigurationRoot = '/etc/treeseed/components';

export interface RuntimeInputProbe {
	runtimeGid(): number;
}

const hostProbe: RuntimeInputProbe = {
	runtimeGid: () => statSync('/var/lib/treeseed/component-secrets').gid,
};

function record(value: unknown, label: string): Record<string, unknown> {
	if (value === undefined) return {};
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
	return value as Record<string, unknown>;
}

function stringRecord(value: unknown, label: string) {
	const values = record(value, label);
	for (const [key, item] of Object.entries(values)) if (typeof item !== 'string') throw new Error(`${label} entry ${key} must be a string.`);
	return values as Record<string, string>;
}

function rejectUnknown(configured: Record<string, string>, accepted: Set<string>, label: string) {
	const unknown = Object.keys(configured).filter((key) => !accepted.has(key)).sort();
	if (unknown.length) throw new Error(`${label} contains undeclared inputs: ${unknown.join(', ')}.`);
}

function secretPath(host: HostConfiguration, secretId: string, expectedPath?: string) {
	const secret = host.secrets[secretId];
	if (!secret || secret.provider !== 'file') throw new Error(`Required secret ${secretId} is not available through file custody.`);
	const path = expectedPath ?? `/etc/treeseed/credentials/${secretId}`;
	if (secret.reference !== path) throw new Error(`Secret ${secretId} must use the declared custody path ${path}.`);
	return path;
}

function managerValue(name: string, secretFiles: string[], probe: RuntimeInputProbe) {
	if (name !== 'RUNTIME_GID') throw new Error(`Manager-derived runtime input ${name} is unsupported.`);
	if (!secretFiles.length) throw new Error('RUNTIME_GID requires at least one declared secret file.');
	return String(probe.runtimeGid());
}

/**
 * Validates the component's complete public, secret, and file custody contract.
 * Only non-secret public/default/manager-derived values are returned; secret
 * values remain under supervisor-owned file custody.
 */
export function managedRuntimeInputEnvironment(host: HostConfiguration, component: ComponentRelease, probe: RuntimeInputProbe = hostProbe) {
	const selection = host.components[component.componentId];
	if (!selection) throw new Error(`Component ${component.componentId} is not configured on this host.`);
	const selected = record(selection.configuration, `${component.componentId} configuration`);
	const configuredEnvironment = stringRecord(selected.environment, `${component.componentId} environment`);
	const configuredSecretEnvironment = stringRecord(selected.secretEnvironment, `${component.componentId} secret environment`);
	const configuredFiles = stringRecord(selected.files, `${component.componentId} managed files`);
	const contract = component.runtime.configuration;
	if (![contract.environment, contract.secretEnvironment, contract.secretFiles, contract.files].some(({ length }) => length > 0)) return {};

	rejectUnknown(configuredEnvironment, new Set(contract.environment.filter(({ source }) => source === 'configuration').map(({ name }) => name)), `${component.componentId} environment`);
	rejectUnknown(configuredSecretEnvironment, new Set(contract.secretEnvironment.map(({ name }) => name)), `${component.componentId} secret environment`);
	rejectUnknown(configuredFiles, new Set(contract.files.map(({ id }) => id)), `${component.componentId} managed files`);

	const fixedSecretPaths: string[] = [];
	for (const declaration of contract.secretEnvironment) {
		const secretId = configuredSecretEnvironment[declaration.name];
		if (!secretId) {
			if (declaration.required) throw new Error(`Required secret environment input ${declaration.name} is not configured for ${component.componentId}.`);
			continue;
		}
		secretPath(host, secretId);
	}
	for (const declaration of contract.secretFiles) {
		const secret = host.secrets[declaration.id];
		if (!secret) {
			if (declaration.required) throw new Error(`Required secret file ${declaration.id} is not configured for ${component.componentId}.`);
			continue;
		}
		const path = secretPath(host, declaration.id, declaration.path);
		fixedSecretPaths.push(path);
	}
	for (const declaration of contract.files) {
		const expectedPath = `${componentConfigurationRoot}/${component.componentId}/${declaration.id}`;
		if (declaration.path !== expectedPath) throw new Error(`Managed file ${declaration.id} must use ${expectedPath}.`);
		if (configuredFiles[declaration.id] === undefined && declaration.required) throw new Error(`Required managed file ${declaration.id} is not configured for ${component.componentId}.`);
	}

	const values: Record<string, string> = {};
	for (const declaration of contract.environment) {
		if (declaration.source === 'manager') {
			if (configuredEnvironment[declaration.name] !== undefined) throw new Error(`Manager-derived input ${declaration.name} cannot be configured by the host.`);
			values[declaration.name] = managerValue(declaration.name, fixedSecretPaths, probe);
			continue;
		}
		const value = configuredEnvironment[declaration.name] ?? declaration.default;
		if (value === undefined) {
			if (declaration.required) throw new Error(`Required environment input ${declaration.name} is not configured for ${component.componentId}.`);
			continue;
		}
		values[declaration.name] = value;
	}
	return values;
}

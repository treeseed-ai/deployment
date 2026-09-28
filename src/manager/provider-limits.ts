import YAML from 'yaml';
import { validateCapacityProviderManifestV5, type CapacityProviderManifestV5 } from '@treeseed/sdk/capacity-provider';
import type { HostConfiguration } from '@treeseed/sdk/deployment';

const manifestName = 'treeseed.capacity-provider.yaml';

function source(host: HostConfiguration): string {
	const value = (host.components.agent?.configuration?.files as Record<string, unknown> | undefined)?.[manifestName];
	if (typeof value !== 'string' || !value.trim()) throw new Error('The managed Agent provider manifest is not configured.');
	return value;
}

function parsed(host: HostConfiguration) {
	const document = YAML.parseDocument(source(host), { uniqueKeys: true });
	if (document.errors.length) throw new Error('The managed Agent provider manifest is invalid.');
	const manifest = document.toJS() as CapacityProviderManifestV5;
	const validation = validateCapacityProviderManifestV5(manifest);
	if (!validation.ok) throw new Error('The managed Agent provider manifest failed SDK validation.');
	return { document, manifest };
}

function limits(adapter: CapacityProviderManifestV5['adapters'][number]) {
	const native = adapter.nativeLimits;
	const cap = native.dailyActiveSecondsLimit;
	const capabilities = native.capabilityLimits;
	if (!Number.isSafeInteger(cap) || !capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities))
		throw new Error(`Execution provider ${adapter.id} has no managed daily active-time limits.`);
	return { modelConfigurationId: native.modelConfigurationId, dailyActiveSecondsLimit: cap,
		capabilityLimits: capabilities as Record<string, { dailyActiveSecondsLimit: number }> };
}

export function showProviderLimits(host: HostConfiguration) {
	return { generation: host.generation, executionProviders: parsed(host).manifest.adapters.map(adapter => ({ id: adapter.id, ...limits(adapter) })) };
}

export function setProviderLimits(host: HostConfiguration, input: {
	providerId: string; dailyActiveSecondsLimit: number; capabilityId?: string; expectedGeneration?: number;
}) {
	if (input.expectedGeneration !== undefined && input.expectedGeneration !== host.generation)
		throw new Error(`Stale host configuration generation: expected ${input.expectedGeneration}, current ${host.generation}.`);
	if (!Number.isSafeInteger(input.dailyActiveSecondsLimit) || input.dailyActiveSecondsLimit < 0)
		throw new Error('Daily active seconds must be a nonnegative safe integer.');
	const { document, manifest } = parsed(host);
	const index = manifest.adapters.findIndex(adapter => adapter.id === input.providerId);
	if (index < 0) throw new Error(`Execution provider ${input.providerId} is not configured.`);
	const adapter = manifest.adapters[index]!;
	const current = limits(adapter);
	if (input.capabilityId) {
		if (!Object.hasOwn(current.capabilityLimits, input.capabilityId))
			throw new Error(`Capability ${input.capabilityId} is not configured on ${input.providerId}.`);
		document.setIn(['adapters', index, 'nativeLimits', 'capabilityLimits', input.capabilityId, 'dailyActiveSecondsLimit'], input.dailyActiveSecondsLimit);
	} else {
		document.setIn(['adapters', index, 'nativeLimits', 'dailyActiveSecondsLimit'], input.dailyActiveSecondsLimit);
		for (const capabilityId of Object.keys(current.capabilityLimits))
			document.setIn(['adapters', index, 'nativeLimits', 'capabilityLimits', capabilityId, 'dailyActiveSecondsLimit'], input.dailyActiveSecondsLimit);
	}
	const nextManifest = document.toJS() as CapacityProviderManifestV5;
	const validation = validateCapacityProviderManifestV5(nextManifest);
	if (!validation.ok) throw new Error('Updated provider limits failed SDK manifest validation.');
	const candidate = structuredClone(host);
	(candidate.components.agent!.configuration!.files as Record<string, string>)[manifestName] = document.toString();
	const changed = source(candidate) !== source(host);
	if (changed) candidate.generation = host.generation + 1;
	return { candidate, changed, limits: showProviderLimits(candidate) };
}

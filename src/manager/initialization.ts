import type { HostConfiguration, HostInitializationProfile, ReleaseCatalog } from '@treeseed/sdk/deployment';

export interface HostInitializationPlan {
	schemaVersion: 'treeseed.host-initialization-result/v1';
	mode: 'plan';
	profile: string;
	track: 'stable' | 'development';
	catalog: { release: string; generation: number; digest: string };
	role: HostInitializationProfile['role'];
	components: string[];
	inputs: HostInitializationProfile['inputs'];
	security: HostInitializationProfile['security'];
	configured: boolean;
	mutation: false;
}

export function planHostInitialization(profileId: string, stable: ReleaseCatalog, development?: ReleaseCatalog, current?: HostConfiguration): HostInitializationPlan {
	if (!/^[a-z][a-z0-9.-]{1,63}$/u.test(profileId)) throw new Error('A valid host initialization profile is required.');
	const candidates = [...(development ? [development] : []), stable];
	const selected = candidates.map((catalog) => ({ catalog, profile: catalog.hostProfiles.find(({ id }) => id === profileId) })).find(({ profile }) => profile);
	if (!selected?.profile) throw new Error(`Host initialization profile ${profileId} is not present in an installed verified catalog.`);
	const configured = Boolean(current);
	if (current) {
		const currentProfiles = new Set(Object.values(current.components).map(({ profile }) => profile).filter(Boolean));
		if (current.host.role !== selected.profile.role || currentProfiles.size !== 1 || !currentProfiles.has(profileId)) throw new Error('This host already has a different configuration; use explicit configuration adoption or uninstall first.');
	}
	return {
		schemaVersion: 'treeseed.host-initialization-result/v1', mode: 'plan', profile: profileId,
		track: selected.catalog.track, catalog: { release: selected.catalog.release, generation: selected.catalog.generation, digest: selected.catalog.catalogDigest },
		role: selected.profile.role, components: [...selected.profile.components], inputs: selected.profile.inputs.map((input) => ({ ...input })),
		security: { ...selected.profile.security }, configured, mutation: false,
	};
}

export function validateHostInitializationInputs(plan: HostInitializationPlan, values: unknown) {
	if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Host initialization inputs must be an object.');
	const record = values as Record<string, unknown>, accepted = new Set(plan.inputs.map(({ name }) => name));
	const unknown = Object.keys(record).filter((name) => !accepted.has(name));
	if (unknown.length) throw new Error(`Host initialization contains undeclared inputs: ${unknown.sort().join(', ')}.`);
	for (const descriptor of plan.inputs) {
		const value = record[descriptor.name];
		if (descriptor.required && (typeof value !== 'string' || value.length === 0)) throw new Error(`Required host initialization input ${descriptor.name} was not provided.`);
		if (value !== undefined && (typeof value !== 'string' || value.length > 16_384)) throw new Error(`Host initialization input ${descriptor.name} is invalid.`);
	}
	const controlPlaneUrl = record.controlPlaneUrl;
	if (typeof controlPlaneUrl === 'string' && !controlPlaneUrl.startsWith('https://')) throw new Error('Control-plane URL must use HTTPS.');
	return Object.keys(record).sort();
}

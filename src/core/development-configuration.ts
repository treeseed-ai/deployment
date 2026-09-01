import { hostConfigurationSchema, type HostConfiguration } from '@treeseed/sdk/deployment';

export const developmentTreedxSecretIds = {
	TREEDX_REMOTE_CREDENTIAL_BROKER_ASSERTION: 'treedx-credential-broker-assertion',
	TREEDX_SECRET_KEY_BASE: 'treedx-secret-key-base',
} as const;

export function developmentTreedxConfiguration() {
	return {
		environment: {
			TREEDX_GIT_ALLOWED_HOSTS: 'github.com', TREEDX_JWT_ALLOWED_ALGS: 'RS256', TREEDX_JWT_AUDIENCE: 'treedx',
			TREEDX_JWT_ISSUER: 'https://api.treeseed.localhost/treedx', TREEDX_REMOTE_CREDENTIAL_BROKER_SERVICE_ID: 'treedx',
		},
		secretEnvironment: { ...developmentTreedxSecretIds },
	};
}

export function reconcileDevelopmentConfiguration(current: HostConfiguration) {
	if (current.runtime.environment !== 'development' || !current.components.treedx?.enabled || !current.components.api?.enabled) return { changed: false, configuration: current };
	const candidate = structuredClone(current), selected = candidate.components.treedx!;
	selected.configuration ??= {};
	const expected = developmentTreedxConfiguration();
	for (const section of ['environment', 'secretEnvironment'] as const) {
		const configured = selected.configuration[section] as Record<string, unknown> | undefined;
		if (configured !== undefined && (!configured || typeof configured !== 'object' || Array.isArray(configured))) throw new Error(`Managed TreeDX ${section} configuration is invalid.`);
		const values = (configured ?? {}) as Record<string, unknown>;
		for (const [name, value] of Object.entries(expected[section])) {
			if (values[name] !== undefined && values[name] !== value) throw new Error(`Managed TreeDX ${name} configuration conflicts with the development profile.`);
			values[name] = value;
		}
		selected.configuration[section] = values as Record<string, string>;
	}
	for (const id of Object.values(developmentTreedxSecretIds)) {
		const expectedSecret = { provider: 'file' as const, reference: `/etc/treeseed/credentials/${id}` }, existing = candidate.secrets[id];
		if (existing && (existing.provider !== expectedSecret.provider || existing.reference !== expectedSecret.reference)) throw new Error(`Managed TreeDX credential ${id} is outside fixed file custody.`);
		candidate.secrets[id] = expectedSecret;
	}
	const changed = JSON.stringify(candidate) !== JSON.stringify(current);
	if (changed) candidate.generation += 1;
	return { changed, configuration: hostConfigurationSchema.parse(candidate) };
}

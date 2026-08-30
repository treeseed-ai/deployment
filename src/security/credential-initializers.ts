import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { hostCredentialInitializerSchema, type HostCredentialInitializer } from '@treeseed/sdk/deployment';

export const credentialInitializerRoot = '/usr/share/treeseed/credential-initializers';
export const credentialRoot = '/etc/treeseed/credentials';

export function loadCredentialInitializers(root = credentialInitializerRoot): HostCredentialInitializer[] {
	if (!existsSync(root)) return [];
	const initializers = readdirSync(root).filter((name) => name.endsWith('.json')).sort().map((name) =>
		hostCredentialInitializerSchema.parse(JSON.parse(readFileSync(resolve(root, name), 'utf8'))));
	const identities = new Set<string>();
	for (const initializer of initializers) {
		if (identities.has(initializer.id)) throw new Error(`Duplicate host credential initializer ${initializer.id}.`);
		identities.add(initializer.id);
	}
	return initializers;
}

export function credentialInitializer(id: string, root = credentialInitializerRoot) {
	const initializer = loadCredentialInitializers(root).find((candidate) => candidate.id === id);
	if (!initializer) throw new Error(`Host credential initializer ${id} is not registered.`);
	return initializer;
}

export function credentialInitializerStatus(root = credentialInitializerRoot) {
	return loadCredentialInitializers(root).map((initializer) => ({
		id: initializer.id,
		displayName: initializer.displayName,
		credentialId: initializer.credentialId,
		configured: existsSync(resolve(credentialRoot, `${initializer.credentialId}.cred`)),
	}));
}

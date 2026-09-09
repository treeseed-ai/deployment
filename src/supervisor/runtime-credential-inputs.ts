import { lstatSync } from 'node:fs';
import { posix } from 'node:path';

export type RuntimeCredentialService = {
	environment?: Record<string, unknown>;
	volumes?: Array<{ type?: string; source?: string; target?: string }>;
};
const credentialFiles = new Set(['TREESEED_PROVIDER_CREDENTIAL_KEK_FILE', 'TREESEED_CAPACITY_ENCRYPTION_KEY_FILE',
	'TREESEED_DIAGNOSTICS_ENCRYPTION_KEY_FILE', 'TREESEED_OPENBAO_IDENTITY_FILE']);

/** A running process is not ready when its declared ephemeral credentials vanished. */
export function missingRuntimeCredentialServices(services: Record<string, RuntimeCredentialService>, fileReady = (path: string) => {
	try { return lstatSync(path).isFile(); } catch { return false; }
}) {
	return Object.entries(services).filter(([, service]) => Object.entries(service.environment ?? {}).some(([name, value]) => {
		if (!credentialFiles.has(name) || typeof value !== 'string' || !value.startsWith('/')) return false;
		const mount = service.volumes?.filter(volume => volume.type === 'bind' && volume.target
			&& (value === volume.target || value.startsWith(`${volume.target}/`)))
			.sort((left, right) => right.target!.length - left.target!.length)[0];
		if (!mount?.source?.startsWith('/run/treeseed/')) return false;
		return !fileReady(posix.join(mount.source, posix.relative(mount.target!, value)));
	})).map(([name]) => name);
}

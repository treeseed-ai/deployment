import type { HostConfiguration } from '@treeseed/sdk/deployment';

const credentialPath = /^\/etc\/treeseed\/credentials\/[a-z0-9][a-z0-9._-]{0,127}$/u;

/** A component may only consume explicitly configured, fixed host credential records. */
export function componentCredential(host: HostConfiguration, id: string, declaredPath = `/etc/treeseed/credentials/${id}`) {
	if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(id) || !credentialPath.test(declaredPath)) throw new Error('Component credential is outside fixed custody.');
	const secret = host.secrets[id];
	if (!secret) throw new Error(`Required secret ${id} is unavailable.`);
	const expected = secret.provider === 'systemd-credential' ? `${declaredPath}.cred` : declaredPath;
	if (secret.reference !== expected) throw new Error(`Secret ${id} must use the declared custody path ${expected}.`);
	return { ...secret, name: declaredPath.slice(declaredPath.lastIndexOf('/') + 1) };
}

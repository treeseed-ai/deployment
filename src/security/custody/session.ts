import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { CustodyError, secretPath, type SecretScope } from './contracts.js';
import { OpenBaoCustody } from './openbao.js';

export interface ManagedOpenBaoConfiguration { address: string; mount: string; identityFile: string }

/** Workload credentials are injected by Deployment, never accepted from a team connection. */
export async function withManagedOpenBao<T>(configuration: ManagedOpenBaoConfiguration, scopes: SecretScope[],
	run: (custody: OpenBaoCustody) => Promise<T>, fetchImpl: typeof fetch = fetch): Promise<T> {
	scopes.forEach(secretPath);
	// Validate transport before reading identity material or sending any bytes.
	new OpenBaoCustody({ ...configuration, token: 'validation-only', scopes, fetchImpl });
	let identity: { roleId: string; secretId: string };
	try {
		const fd = openSync(configuration.identityFile, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o027) || stat.size > 16_384) throw new Error();
			identity = JSON.parse(readFileSync(fd, 'utf8'));
		} finally { closeSync(fd); }
		if (typeof identity.roleId !== 'string' || !identity.roleId || typeof identity.secretId !== 'string' || !identity.secretId) throw new Error();
	} catch { throw new CustodyError('workload_identity_unavailable'); }
	let token: string | undefined;
	try {
		const response = await fetchImpl(`${new URL(configuration.address).origin}/v1/auth/approle/login`, {
			method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ role_id: identity.roleId, secret_id: identity.secretId }),
		});
		if (!response.ok) throw new Error();
		if (!response.body) throw new Error();
		const reader = response.body.getReader(), chunks: Uint8Array[] = [];
		let length = 0;
		let payload: any;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				length += value.byteLength;
				if (length > 65_536) throw new Error();
				chunks.push(value);
			}
			payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		} finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
		token = typeof payload?.auth?.client_token === 'string' ? payload.auth.client_token : undefined;
		if (!token || !Array.isArray(payload.auth.policies)
			|| payload.auth.policies.includes('root') || !Number.isInteger(payload.auth.lease_duration)
			|| payload.auth.lease_duration < 1 || payload.auth.lease_duration > 300) throw new Error();
	} catch {
		if (token) {
			try { await new OpenBaoCustody({ ...configuration, token, scopes, fetchImpl }).close(); } catch { /* bounded failed login cleanup */ }
		}
		throw new CustodyError('workload_authentication_failed');
	}
	const custody = new OpenBaoCustody({ ...configuration, token, scopes, fetchImpl });
	try { return await run(custody); } finally { await custody.close(); }
}

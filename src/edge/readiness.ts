import { connect } from 'node:tls';
import { readFileSync } from 'node:fs';

/** Verify the actual local listener and server identity, including mTLS routes. */
export function verifyEdgeAlias(alias: string, ca: string, port = 443): Promise<boolean> {
	if (!/^[a-z0-9.-]+\.localhost$/u.test(alias)) return Promise.resolve(false);
	return new Promise(resolve => {
		let settled = false;
		const finish = (ok: boolean) => { if (!settled) { settled = true; socket.destroy(); resolve(ok); } };
		const socket = connect({ host: '127.0.0.1', port, servername: alias, ca, rejectUnauthorized: true });
		socket.setTimeout(5_000, () => finish(false));
		socket.once('secureConnect', () => finish(socket.authorized));
		socket.once('error', () => finish(false));
		socket.once('close', () => finish(false));
	});
}

export async function edgeReadiness(aliases: readonly string[], caPath = '/etc/treeseed/cli/localhost-ca.crt') {
	let ca: string;
	try { ca = readFileSync(caPath, 'utf8'); } catch { return false; }
	return aliases.length > 0 && (await Promise.all(aliases.map(alias => verifyEdgeAlias(alias, ca)))).every(Boolean);
}

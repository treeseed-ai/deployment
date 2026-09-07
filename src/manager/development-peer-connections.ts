import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { atomicJson } from '../core/files.js';
import { paths } from '../core/paths.js';

export function connectionDigest(environment: Record<string, string>) {
	return createHash('sha256').update(JSON.stringify(Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
}

const receiptPath = (componentId: string) => {
	if (!/^[a-z0-9][a-z0-9-]*$/u.test(componentId)) throw new Error('Invalid component identity.');
	return `${paths.managerState}/development-connections-${componentId}.json`;
};

export function recordConnectionDigest(componentId: string, environment: Record<string, string>) {
	atomicJson(receiptPath(componentId), { digest: connectionDigest(environment) }, 0o600);
}

export function readConnectionDigest(componentId: string) {
	const path = receiptPath(componentId);
	if (!existsSync(path)) return undefined;
	const value = JSON.parse(readFileSync(path, 'utf8')) as { digest?: unknown };
	if (typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.digest)) throw new Error('Invalid development connection receipt.');
	return value.digest;
}

/** Missing receipts represent the released address, not permission to restart every service. */
export async function reconcilePeerConnections(
	peers: Array<{ componentId: string; released: Record<string, string>; desired: Record<string, string> }>,
	held: ReadonlySet<string>,
	operations: { read: (id: string) => string | undefined; activate: (id: string) => Promise<unknown> },
) {
	const changed: string[] = [];
	for (const peer of peers) {
		if (held.has(peer.componentId)) continue;
		if ((operations.read(peer.componentId) ?? connectionDigest(peer.released)) === connectionDigest(peer.desired)) continue;
		await operations.activate(peer.componentId);
		changed.push(peer.componentId);
	}
	return changed;
}

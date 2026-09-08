import { createHash, createHmac, randomUUID } from 'node:crypto';

export type AiStorageAction = 'read' | 'write' | 'list' | 'delete';
export interface AiStorageOperation {
	teamId: string;
	projectId: string;
	nodeId: string;
	storeId: string;
	action: AiStorageAction;
	key: string;
}

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const denied = () => new Error('AI storage authority is invalid or unavailable.');
const actions = {
	read: ['GetObject', 'HeadObject'],
	write: ['PutObject', 'CreateMultipartUpload', 'UploadPart', 'CompleteMultipartUpload', 'AbortMultipartUpload'],
	list: ['ListObjectsV2'],
	delete: ['DeleteObject'],
} as const;

/** Adopt or create the selected private bucket without changing an existing bucket's policy. */
export async function ensureAiStorageBucket(input: { accountId: string; bucket: string; apiToken: string }, fetchImpl: typeof fetch = fetch) {
	try {
		if (!/^[a-f0-9]{32}$/u.test(input.accountId) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(input.bucket)
			|| !input.apiToken || /[\r\n\0]/u.test(input.apiToken)) throw denied();
		const root = `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/r2/buckets`;
		const request = async (url: string, init: RequestInit = {}) => {
			const response = await fetchImpl(url, { ...init, headers: { authorization: `Bearer ${input.apiToken}`, 'content-type': 'application/json' },
				redirect: 'error', signal: AbortSignal.timeout(10_000) });
			if (!response.ok) { await response.body?.cancel(); return { status: response.status, body: null }; }
			if (!response.body) throw denied();
			const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
			try {
				for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 65_536) throw denied(); chunks.push(value); }
				const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
				if (body.success !== true) throw denied(); return { status: response.status, body: body.result };
			} finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
		};
		let bucket = await request(`${root}/${input.bucket}`);
		if (bucket.status === 404) bucket = await request(root, { method: 'POST', body: JSON.stringify({ name: input.bucket }) });
		if (!bucket.body || bucket.body.name !== input.bucket) throw denied();
		const [managed, custom] = await Promise.all([request(`${root}/${input.bucket}/domains/managed`), request(`${root}/${input.bucket}/domains/custom`)]);
		if (managed.body?.enabled !== false || !Array.isArray(custom.body?.domains) || custom.body.domains.some((domain: any) => domain.enabled !== false)) throw denied();
		return { bucket: input.bucket, verifiedPrivate: true as const };
	} catch { throw denied(); }
}

/** One node allocation; provider account, bucket and object prefix are never caller-selected by AI. */
export function aiStorageAllocation(operation: AiStorageOperation) {
	if (![operation.teamId, operation.projectId, operation.nodeId].every(value => uuid.test(value))
		|| !/^[a-z][a-z0-9-]{0,62}$/u.test(operation.storeId) || !Object.hasOwn(actions, operation.action)) throw denied();
	const key = operation.key;
	if (typeof key !== 'string' || key.length > 1024 || /[\\\x00-\x1f\x7f%?#]/u.test(key)
		|| (key && key.split('/').some(part => !part || part === '.' || part === '..'))
		|| (!key && operation.action !== 'list')) throw denied();
	const prefix = `teams/${operation.teamId}/projects/${operation.projectId}/ai/v1/nodes/${operation.nodeId}/${operation.storeId}/`;
	return { prefix, objectKey: `${prefix}${key}` };
}

async function tokenIdentity(accountId: string, token: string, fetchImpl: typeof fetch) {
	// User-owned and account-owned R2 tokens have different verification endpoints.
	for (const path of [`accounts/${accountId}/tokens/verify`, 'user/tokens/verify']) {
		const response = await fetchImpl(`https://api.cloudflare.com/client/v4/${path}`, {
			headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10_000),
		});
		if ([401, 403].includes(response.status)) { await response.body?.cancel(); continue; }
		if (!response.ok || !response.body) { await response.body?.cancel(); throw denied(); }
		const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
		try {
			for (;;) {
				const { value, done } = await reader.read(); if (done) break;
				size += value.byteLength; if (size > 65_536) throw denied(); chunks.push(value);
			}
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			if (body.success !== true || body.result?.status !== 'active' || !/^[a-f0-9]{32}$/u.test(body.result?.id ?? '')) throw denied();
			return String(body.result.id);
		} finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
	}
	throw denied();
}

/**
 * Implements Cloudflare's documented short-lived R2 JWT credentials. Parent material
 * remains within the trusted custody callback; the runtime receives one action/path.
 * https://developers.cloudflare.com/r2/examples/authenticate-r2-temp-credentials/
 */
export async function createAiStorageCredentials(input: {
	accountId: string; bucket: string; apiToken: string; operation: AiStorageOperation;
}, options: { fetchImpl?: typeof fetch; now?: number } = {}) {
	try {
		const { accountId, bucket, apiToken, operation } = input;
		if (!/^[a-f0-9]{32}$/u.test(accountId) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(bucket)
			|| typeof apiToken !== 'string' || !apiToken || /[\r\n\0]/u.test(apiToken)) throw denied();
		const allocation = aiStorageAllocation(operation);
		const parentId = await tokenIdentity(accountId, apiToken, options.fetchImpl ?? fetch);
		const now = options.now ?? Math.floor(Date.now() / 1000);
		if (!Number.isSafeInteger(now) || now < 1) throw denied();
		const endpoint = `https://${accountId}.r2.cloudflarestorage.com`, expires = now + 60;
		const claims = { iss: parentId, sub: accountId, aud: new URL(endpoint).host, iat: now, exp: expires, jti: randomUUID(),
			// R2 rejects tokens combining preset scope and explicit actions. Keep the narrower action grant.
			bucket,
			actions: actions[operation.action], paths: operation.action === 'list'
				? { prefixPaths: [allocation.objectKey], objectPaths: [] } : { prefixPaths: [], objectPaths: [allocation.objectKey] } };
		const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
		const unsigned = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
		const parentKey = Buffer.from(createHash('sha256').update(apiToken).digest('hex'));
		let jwt: string;
		try { jwt = `${unsigned}.${createHmac('sha256', parentKey).update(unsigned).digest('base64url')}`; }
		finally { parentKey.fill(0); }
		return { endpoint, bucket, ...allocation, expiresAt: new Date(expires * 1000).toISOString(), credentials: {
			accessKeyId: parentId, secretAccessKey: createHash('sha256').update(jwt).digest('hex'),
			sessionToken: Buffer.from(`jwt/${jwt}`).toString('base64'),
		} };
	} catch { throw denied(); }
}

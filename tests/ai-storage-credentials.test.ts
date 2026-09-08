import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { aiStorageAllocation, createAiStorageCredentials, ensureAiStorageBucket, type AiStorageOperation } from '../src/security/services/ai-storage.js';

const operation: AiStorageOperation = { teamId: '11111111-1111-4111-8111-111111111111', projectId: '22222222-2222-4222-8222-222222222222',
	nodeId: '33333333-3333-4333-8333-333333333333', storeId: 'managed-training', action: 'read', key: 'model/manifest.json' };
const input = { accountId: 'a'.repeat(32), bucket: 'test-ai-artifacts', apiToken: 'test-parent-not-a-real-token', operation };
const verified = () => Response.json({ success: true, result: { status: 'active', id: 'b'.repeat(32) } });
function claims(result: Awaited<ReturnType<typeof createAiStorageCredentials>>) {
	const jwt = Buffer.from(result.credentials.sessionToken, 'base64').toString().slice(4);
	return { jwt, body: JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) };
}
describe('AI operation-scoped R2 credentials', () => {
	it('adopts a private bucket without writing provider policy', async () => {
		const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({ success: true, result: { name: input.bucket } }))
			.mockResolvedValueOnce(Response.json({ success: true, result: { enabled: false } }))
			.mockResolvedValueOnce(Response.json({ success: true, result: { domains: [] } }));
		expect(await ensureAiStorageBucket(input, fetchImpl)).toEqual({ bucket: input.bucket, verifiedPrivate: true });
		expect(fetchImpl.mock.calls.every(([, init]) => !init.method)).toBe(true);
	});
	it('creates only the explicitly selected missing bucket', async () => {
		const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('', { status: 404 }))
			.mockResolvedValueOnce(Response.json({ success: true, result: { name: input.bucket } }))
			.mockResolvedValueOnce(Response.json({ success: true, result: { enabled: false } }))
			.mockResolvedValueOnce(Response.json({ success: true, result: { domains: [] } }));
		await ensureAiStorageBucket(input, fetchImpl);
		expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ name: input.bucket }) });
	});
	it('rejects public storage without silently disabling its domains', async () => {
		const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({ success: true, result: { name: input.bucket } }))
			.mockResolvedValueOnce(Response.json({ success: true, result: { enabled: true } }))
			.mockResolvedValueOnce(Response.json({ success: true, result: { domains: [] } }));
		await expect(ensureAiStorageBucket(input, fetchImpl)).rejects.toThrow(/authority/);
		expect(fetchImpl.mock.calls.every(([, init]) => !init.method)).toBe(true);
	});
	it('binds one object and read actions, with a 60-second expiry and no parent secret', async () => {
		const result = await createAiStorageCredentials(input, { fetchImpl: vi.fn(async () => verified()), now: 100 });
		const { jwt, body } = claims(result);
		expect(body).toMatchObject({ iat: 100, exp: 160, actions: ['GetObject', 'HeadObject'],
			paths: { objectPaths: [aiStorageAllocation(operation).objectKey], prefixPaths: [] } });
		const unsigned = jwt.split('.').slice(0, 2).join('.');
		expect(jwt.split('.')[2]).toBe(createHmac('sha256', createHash('sha256').update(input.apiToken).digest('hex')).update(unsigned).digest('base64url'));
		expect(JSON.stringify(result)).not.toContain(input.apiToken);
		expect(result.credentials.secretAccessKey).toBe(createHash('sha256').update(jwt).digest('hex'));
	});
	it.each(['read', 'write', 'list', 'delete'] as const)('uses only explicit actions for %s; never combines them with a preset scope', async action => {
		const result = await createAiStorageCredentials({ ...input, operation: { ...operation, action } }, { fetchImpl: vi.fn(async () => verified()) });
		const body = claims(result).body;
		expect(body).not.toHaveProperty('scope');
		expect(body.actions).toEqual({ read: ['GetObject', 'HeadObject'], write: ['PutObject', 'CreateMultipartUpload', 'UploadPart', 'CompleteMultipartUpload', 'AbortMultipartUpload'], list: ['ListObjectsV2'], delete: ['DeleteObject'] }[action]);
	});
	it('bounds list to this node allocation and separates every tenant and store', async () => {
		const result = await createAiStorageCredentials({ ...input, operation: { ...operation, action: 'list', key: '' } }, { fetchImpl: vi.fn(async () => verified()) });
		expect(claims(result).body.paths).toEqual({ prefixPaths: [aiStorageAllocation(operation).prefix], objectPaths: [] });
		for (const field of ['teamId', 'projectId', 'nodeId', 'storeId'] as const) {
			const changed = { ...operation, [field]: field === 'storeId' ? 'another-store' : '44444444-4444-4444-8444-444444444444' };
			expect(aiStorageAllocation(changed).prefix).not.toBe(aiStorageAllocation(operation).prefix);
		}
	});
	it.each(['../secret', '/root', 'x//y', 'x/../y', '%2e%2e/key', 'x\\y', '', 'x?query'])('rejects unsafe object %s before provider access', async key => {
		const fetchImpl = vi.fn();
		await expect(createAiStorageCredentials({ ...input, operation: { ...operation, key } }, { fetchImpl })).rejects.toThrow(/authority/);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
	it('supports account/user token verification and redacts upstream failures', async () => {
		const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('', { status: 403 })).mockResolvedValueOnce(verified());
		await createAiStorageCredentials(input, { fetchImpl }); expect(fetchImpl).toHaveBeenCalledTimes(2);
		await expect(createAiStorageCredentials(input, { fetchImpl: vi.fn(async () => { throw new Error(input.apiToken); }) })).rejects.toThrow('AI storage authority is invalid or unavailable.');
	});
});

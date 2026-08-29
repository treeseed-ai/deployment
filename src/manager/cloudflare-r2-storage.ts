import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { requestSupervisor } from '../supervisor/client.js';

const secretIds = {
	accountId: 'cloudflare-r2-account-id', managementToken: 'cloudflare-r2-management-token',
	bucketName: 'cloudflare-r2-bucket-name', accessKeyId: 'cloudflare-r2-access-key-id',
	secretAccessKey: 'cloudflare-r2-secret-access-key',
} as const;
const root = '/var/lib/treeseed/manager/storage/cloudflare-r2';
const safe = (value: string) => value.replaceAll(/[^a-z0-9-]/giu, '-').toLowerCase();
const metadataPath = (teamId: string) => `${root}/teams/${safe(teamId)}.json`;
const authorityPath = (accountId: string) => `${root}/authorities/${accountId}.token`;
const bucketName = (teamId: string) => `treeseed-team-${teamId.replaceAll(/[^a-z0-9]/giu, '').toLowerCase().slice(0, 8)}-library`;

async function request(token: string, path: string, init?: RequestInit) {
	const response = await fetch(`https://api.cloudflare.com/client/v4/${path}`, { ...init,
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init?.headers ?? {}) } });
	const body = await response.json().catch(() => null) as any;
	if (!response.ok || body?.success === false) {
		const detail = Array.isArray(body?.errors) ? body.errors.map((item: any) => item?.message).filter(Boolean).join('; ') : '';
		throw new Error(`Cloudflare request failed for ${path} (HTTP ${response.status})${detail ? `: ${detail}` : ''}.`);
	}
	return body?.result;
}

function privateBucket(managed: any, custom: any) {
	const domains = Array.isArray(custom?.domains) ? custom.domains : Array.isArray(custom) ? custom : [];
	if (managed?.enabled === true || domains.some((domain: any) => domain?.enabled === true)) throw new Error('Cloudflare R2 library bucket has public domain access enabled.');
	return { r2DevEnabled: false, enabledCustomDomains: 0 };
}

function metadata(teamId: string) {
	const path = metadataPath(teamId);
	return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as any : null;
}

export async function cloudflareR2StorageStatus(teamId: string) {
	const record = metadata(teamId);
	const custody = await requestSupervisor<any>({ operation: 'storage.r2.status', teamId });
	const binding = record ?? custody?.binding ?? null;
	return { backend: 'cloudflare-r2', teamId, configured: Boolean(binding && custody?.childCredentialsReady),
		accountId: binding?.accountId ?? null, bucket: binding?.bucket ?? bucketName(teamId), tokens: binding?.tokens ?? null, custody };
}

export async function provisionCloudflareR2Storage(input: { action: 'connect' | 'reconcile' | 'rotate'; teamId: string; teamSlug: string; accountId?: string; bootstrapToken?: string; plan: boolean }) {
	const prior = metadata(input.teamId);
	if (input.plan) return { backend: 'cloudflare-r2', action: input.action, teamId: input.teamId,
		bucket: prior?.bucket ?? bucketName(input.teamId), mutation: false, configured: Boolean(prior) };
	let bootstrapToken = input.bootstrapToken?.trim();
	if (!bootstrapToken && prior?.accountId && existsSync(authorityPath(prior.accountId))) bootstrapToken = readFileSync(authorityPath(prior.accountId), 'utf8').trim();
	if (!bootstrapToken) throw new Error('Cloudflare R2 provisioning authority is unavailable; run `trsd host storage connect cloudflare-r2`.');
	const accounts: any[] = await request(bootstrapToken, 'accounts?per_page=50');
	const account = input.accountId ? accounts.find((entry) => entry?.id === input.accountId)
		: prior?.accountId ? accounts.find((entry) => entry?.id === prior.accountId)
		: accounts.length === 1 ? accounts[0] : null;
	if (!account?.id) throw new Error('Cloudflare account selection is ambiguous; pass --account-id when connecting storage.');
	const accountId = String(account.id), bucket = prior?.bucket ?? bucketName(input.teamId);
	const r2 = (path: string, init?: RequestInit) => request(bootstrapToken!, `accounts/${accountId}/r2/${path}`, init);
	const listed: any = await r2('buckets');
	if (!(listed?.buckets ?? listed ?? []).some((entry: any) => entry?.name === bucket)) {
		await r2('buckets', { method: 'POST', body: JSON.stringify({ name: bucket, locationHint: 'enam', storageClass: 'Standard' }) });
	}
	const privacy = privateBucket(await r2(`buckets/${bucket}/domains/managed`), await r2(`buckets/${bucket}/domains/custom`));
	const groups: any[] = await request(bootstrapToken, `accounts/${accountId}/tokens/permission_groups`);
	const permission = (name: string, scope: string) => {
		const result = groups.find((entry) => entry?.name === name && entry?.scopes?.includes(scope));
		if (!result?.id) throw new Error(`Cloudflare permission group ${name} is unavailable.`);
		return String(result.id);
	};
	const tokenList: any[] = await request(bootstrapToken, `accounts/${accountId}/tokens?per_page=50`);
	const names = { privacy: `TreeSeed ${input.teamId} Library Privacy Verifier`, publisher: `TreeSeed ${input.teamId} Library Content Publisher` };
	const ensureToken = async (name: string, permissionId: string, resources: Record<string, string>) => {
		const existing = tokenList.find((entry) => entry?.name === name && entry?.status === 'active');
		const mustRecover = !prior || input.action === 'rotate';
		if (existing && !mustRecover) return { id: String(existing.id), value: null as string | null, created: false, rotated: false };
		if (existing) {
			const rolled: any = await request(bootstrapToken!, `accounts/${accountId}/tokens/${existing.id}/value`, { method: 'PUT', body: '{}' });
			const value = typeof rolled === 'string' ? rolled : rolled?.value;
			if (!value) throw new Error(`Cloudflare did not return the rotated value for ${name}.`);
			return { id: String(existing.id), value: String(value), created: false, rotated: true };
		}
		const created: any = await request(bootstrapToken!, `accounts/${accountId}/tokens`, { method: 'POST', body: JSON.stringify({ name,
			policies: [{ effect: 'allow', permission_groups: [{ id: permissionId }], resources }] }) });
		if (!created?.id || !created?.value) throw new Error(`Cloudflare did not return credentials for ${name}.`);
		return { id: String(created.id), value: String(created.value), created: true, rotated: false };
	};
	const privacyToken = await ensureToken(names.privacy, permission('Workers R2 Storage Read', 'com.cloudflare.api.account'), { [`com.cloudflare.api.account.${accountId}`]: '*' });
	const publisherToken = await ensureToken(names.publisher, permission('Workers R2 Storage Bucket Item Write', 'com.cloudflare.edge.r2.bucket'), { [`com.cloudflare.edge.r2.bucket.${accountId}_default_${bucket}`]: '*' });
	if (privacyToken.value && publisherToken.value) await requestSupervisor({ operation: 'storage.r2.install', teamId: input.teamId, accountId, bucket,
		bootstrapToken, managementToken: privacyToken.value, accessKeyId: publisherToken.id,
		secretAccessKey: createHash('sha256').update(publisherToken.value).digest('hex'), privacyTokenId: privacyToken.id, publisherTokenId: publisherToken.id });
	return { backend: 'cloudflare-r2', action: input.action, teamId: input.teamId, teamSlug: input.teamSlug, accountId, bucket, privacy,
		tokens: { privacy: { name: names.privacy, id: privacyToken.id }, publisher: { name: names.publisher, id: publisherToken.id } },
		secretIds, mutation: true };
}

export { secretIds as cloudflareR2SecretIds };

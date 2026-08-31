import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { requestSupervisor } from '../supervisor/client.js';
import { defaultReplicationBucket, type ControlPlaneStorageEnvironment } from '../cloudflare/r2-replication-provisioning.js';

const secretIds = {
	accountId: 'cloudflare-r2-account-id', managementToken: 'cloudflare-r2-management-token',
	bucketName: 'cloudflare-r2-bucket-name', accessKeyId: 'cloudflare-r2-access-key-id',
	secretAccessKey: 'cloudflare-r2-secret-access-key',
} as const;
const root = '/var/lib/treeseed/manager/storage/cloudflare-r2';
const safe = (value: string) => value.replaceAll(/[^a-z0-9-]/giu, '-').toLowerCase();
const metadataPath = (controlPlaneId: string) => `${root}/control-planes/${safe(controlPlaneId)}.json`;
const authorityPath = (accountId: string) => `${root}/authorities/${accountId}.token`;
const bucketName = (controlPlaneId: string, environment: ControlPlaneStorageEnvironment) =>
	defaultReplicationBucket(controlPlaneId, environment);

async function requestEnvelope(token: string, path: string, init?: RequestInit) {
	const response = await fetch(`https://api.cloudflare.com/client/v4/${path}`, { ...init,
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init?.headers ?? {}) } });
	const body = await response.json().catch(() => null) as any;
	if (!response.ok || body?.success === false) {
		const detail = Array.isArray(body?.errors) ? body.errors.map((item: any) => item?.message).filter(Boolean).join('; ') : '';
		throw new Error(`Cloudflare request failed for ${path} (HTTP ${response.status})${detail ? `: ${detail}` : ''}.`);
	}
	return body;
}

async function request(token: string, path: string, init?: RequestInit) {
	return (await requestEnvelope(token, path, init))?.result;
}

function privateBucket(managed: any, custom: any) {
	const domains = Array.isArray(custom?.domains) ? custom.domains : Array.isArray(custom) ? custom : [];
	if (managed?.enabled === true || domains.some((domain: any) => domain?.enabled === true)) throw new Error('Cloudflare R2 library bucket has public domain access enabled.');
	return { r2DevEnabled: false, enabledCustomDomains: 0 };
}

function metadata(controlPlaneId: string) {
	const path = metadataPath(controlPlaneId);
	return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as any : null;
}

function retainedBootstrapToken(controlPlaneId: string) {
	const prior = metadata(controlPlaneId);
	if (prior?.accountId && existsSync(authorityPath(prior.accountId))) return readFileSync(authorityPath(prior.accountId), 'utf8').trim();
	if (existsSync(`${root}/authorities`)) {
		const retained = readdirSync(`${root}/authorities`).filter((name) => /^[a-f0-9]{32}\.token$/u.test(name));
		if (retained.length === 1) return readFileSync(`${root}/authorities/${retained[0]}`, 'utf8').trim();
	}
	throw new Error('Cloudflare R2 provisioning authority is unavailable; run `trsd host storage connect cloudflare-r2`.');
}

const encodeObjectKey = (key: string) => key.split('/').map(encodeURIComponent).join('/');

export async function resetCloudflareR2Bucket(controlPlaneId: string, environment: ControlPlaneStorageEnvironment) {
	const bootstrapToken = retainedBootstrapToken(controlPlaneId);
	const accounts: any[] = await request(bootstrapToken, 'accounts?per_page=50');
	const prior = metadata(controlPlaneId);
	const account = prior?.accountId ? accounts.find((entry) => entry?.id === prior.accountId) : accounts.length === 1 ? accounts[0] : null;
	if (!account?.id) throw new Error('Cloudflare account selection is ambiguous; reconnect storage with an explicit account ID.');
	const accountId = String(account.id), bucket = bucketName(controlPlaneId, environment);
	const api = (path: string, init?: RequestInit) => request(bootstrapToken, `accounts/${accountId}/r2/${path}`, init);
	const listed: any = await api('buckets');
	const exists = (listed?.buckets ?? listed ?? []).some((entry: any) => entry?.name === bucket);
	let deletedObjects = 0;
	if (exists) {
		for (let pass = 0; pass < 10_000; pass += 1) {
			const page = await requestEnvelope(bootstrapToken,
				`accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/objects?per_page=1000`);
			const keys = (Array.isArray(page?.result) ? page.result : []).map((entry: any) => String(entry?.key ?? '')).filter(Boolean);
			if (!keys.length) break;
			for (let index = 0; index < keys.length; index += 16) {
				await Promise.all(keys.slice(index, index + 16).map((key: string) =>
					api(`buckets/${encodeURIComponent(bucket)}/objects/${encodeObjectKey(key)}`, { method: 'DELETE' })));
			}
			deletedObjects += keys.length;
			if (pass === 9_999) throw new Error(`Cloudflare R2 bucket ${bucket} exceeded the bounded emptying limit.`);
		}
		await api(`buckets/${encodeURIComponent(bucket)}`, { method: 'DELETE' });
	}
	await api('buckets', { method: 'POST', body: JSON.stringify({ name: bucket, locationHint: 'enam', storageClass: 'Standard' }) });
	const privacy = privateBucket(await api(`buckets/${bucket}/domains/managed`), await api(`buckets/${bucket}/domains/custom`));
	const remaining = await requestEnvelope(bootstrapToken,
		`accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/objects?per_page=1`);
	if ((Array.isArray(remaining?.result) ? remaining.result : []).length) throw new Error(`Recreated Cloudflare R2 bucket ${bucket} was not empty.`);
	return { backend: 'cloudflare-r2', action: 'reset', controlPlaneId, environment, accountId, bucket,
		deletedObjects, recreated: true, empty: true, privacy, mutation: true };
}

export async function cloudflareR2StorageStatus(controlPlaneId: string, environment: ControlPlaneStorageEnvironment) {
	const record = metadata(controlPlaneId);
	const custody = await requestSupervisor<any>({ operation: 'storage.r2.status', controlPlaneId });
	const binding = record ?? custody?.binding ?? null;
	const desiredBucket = bucketName(controlPlaneId, environment);
	return { backend: 'cloudflare-r2', controlPlaneId,
		configured: Boolean(binding?.bucket === desiredBucket && custody?.childCredentialsReady),
		accountId: binding?.accountId ?? null, bucket: binding?.bucket ?? desiredBucket, desiredBucket, environment,
		tokens: binding?.tokens ?? null, custody };
}

export async function provisionCloudflareR2Storage(input: { action: 'connect' | 'reconcile' | 'rotate'; controlPlaneId: string;
	environment: ControlPlaneStorageEnvironment; accountId?: string; bootstrapToken?: string; plan: boolean }) {
	const prior = metadata(input.controlPlaneId);
	if (input.plan) return { backend: 'cloudflare-r2', action: input.action, controlPlaneId: input.controlPlaneId,
		environment: input.environment, bucket: bucketName(input.controlPlaneId, input.environment), mutation: false,
		configured: Boolean(prior && prior.bucket === bucketName(input.controlPlaneId, input.environment)) };
	const bootstrapToken = input.bootstrapToken?.trim() || retainedBootstrapToken(input.controlPlaneId);
	const accounts: any[] = await request(bootstrapToken, 'accounts?per_page=50');
	const account = input.accountId ? accounts.find((entry) => entry?.id === input.accountId)
		: prior?.accountId ? accounts.find((entry) => entry?.id === prior.accountId)
		: accounts.length === 1 ? accounts[0] : null;
	if (!account?.id) throw new Error('Cloudflare account selection is ambiguous; pass --account-id when connecting storage.');
	const accountId = String(account.id), bucket = bucketName(input.controlPlaneId, input.environment);
	const environmentChanged = Boolean(prior && prior.bucket !== bucket);
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
	const names = { privacy: `TreeSeed ${input.controlPlaneId} ${input.environment} Library Privacy Verifier`,
		publisher: `TreeSeed ${input.controlPlaneId} ${input.environment} Library Content Publisher` };
	const ensureToken = async (name: string, permissionId: string, resources: Record<string, string>) => {
		const existing = tokenList.find((entry) => entry?.name === name && entry?.status === 'active');
		const mustRecover = !prior || environmentChanged || input.action === 'rotate';
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
	if (privacyToken.value && publisherToken.value) await requestSupervisor({ operation: 'storage.r2.install', controlPlaneId: input.controlPlaneId, accountId, bucket,
		bootstrapToken, managementToken: privacyToken.value, accessKeyId: publisherToken.id,
		secretAccessKey: createHash('sha256').update(publisherToken.value).digest('hex'), privacyTokenId: privacyToken.id, publisherTokenId: publisherToken.id });
	return { backend: 'cloudflare-r2', action: input.action, controlPlaneId: input.controlPlaneId,
		environment: input.environment, accountId, bucket, privacy,
		tokens: { privacy: { name: names.privacy, id: privacyToken.id }, publisher: { name: names.publisher, id: publisherToken.id } },
		secretIds, credentialsChanged: Boolean(privacyToken.value && publisherToken.value), mutation: true };
}

export { secretIds as cloudflareR2SecretIds };

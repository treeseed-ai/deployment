import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { addReplicationSecrets, assertPrivateDomains, defaultReplicationBucket, r2ReplicationSecretIds } from '../src/cloudflare/r2-replication-provisioning.js';

function value(name: string) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

const accountId = value('--account-id');
const teamId = value('--team-id');
const bootstrapTokenFile = value('--bootstrap-token-file');
const configurationPath = resolve(value('--configuration') ?? '/etc/treeseed/platform.json');
const bucket = value('--bucket') ?? (teamId ? defaultReplicationBucket(teamId) : undefined);
const apply = process.argv.includes('--apply');
const rotateTokens = process.argv.includes('--rotate-tokens');
if (!accountId || !/^[a-f0-9]{32}$/u.test(accountId) || !teamId || !bucket) {
	throw new Error('Usage: provision-r2-replication --account-id ID --team-id ID [--bootstrap-token-file FILE] [--bucket NAME] [--apply] [--rotate-tokens]');
}
if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/u.test(bucket)) throw new Error('R2 bucket name is invalid.');
const readSecret = (path: string) => {
	const result = readFileSync(resolve(path), 'utf8').trim();
	if (!result || result.length > 65_536) throw new Error(`Credential file ${path} is empty or invalid.`);
	return result;
};
const bootstrapToken = bootstrapTokenFile ? readSecret(bootstrapTokenFile)
	: execFileSync('systemd-ask-password', ['Cloudflare TreeSeed deployment bootstrap token'], { encoding: 'utf8' }).trim();
if (bootstrapToken.length < 16) throw new Error('Cloudflare bootstrap token is invalid.');
const headers = { authorization: `Bearer ${bootstrapToken}`, 'content-type': 'application/json' };
const cloudflareApi = async (path: string, init?: RequestInit) => {
	const response = await fetch(`https://api.cloudflare.com/client/v4/${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
	const body = await response.json().catch(() => null) as any;
	if (!response.ok || body?.success === false) throw new Error(`Cloudflare request failed for ${path} (HTTP ${response.status}).`);
	return body?.result;
};
const r2Api = (path: string, init?: RequestInit) => cloudflareApi(`accounts/${accountId}/r2/${path}`, init);
const privacyTokenName = `TreeSeed ${teamId} Library Privacy Verifier`;
const publisherTokenName = `TreeSeed ${teamId} Library Content Publisher`;
const accountResource = `com.cloudflare.api.account.${accountId}`;
const bucketResource = `com.cloudflare.edge.r2.bucket.${accountId}_default_${bucket}`;
const buckets: any = await r2Api('buckets');
const bucketExists = (buckets?.buckets ?? buckets ?? []).some((entry: any) => entry?.name === bucket);
if (apply && !bucketExists) await r2Api('buckets', { method: 'POST', body: JSON.stringify({ name: bucket, locationHint: 'enam', storageClass: 'Standard' }) });
const privacy = bucketExists || apply ? assertPrivateDomains(
	await r2Api(`buckets/${encodeURIComponent(bucket)}/domains/managed`),
	await r2Api(`buckets/${encodeURIComponent(bucket)}/domains/custom`),
) : null;
const permissionGroups: any[] = await cloudflareApi(`accounts/${accountId}/tokens/permission_groups`);
const permissionId = (name: string, scope: string) => {
	const group = permissionGroups.find((entry) => entry?.name === name && entry?.scopes?.includes(scope));
	if (!group?.id) throw new Error(`Cloudflare permission group ${name} (${scope}) is unavailable.`);
	return String(group.id);
};
const privacyPermissionId = permissionId('Workers R2 Storage Read', 'com.cloudflare.api.account');
const publisherPermissionId = permissionId('Workers R2 Storage Bucket Item Write', 'com.cloudflare.edge.r2.bucket');
const listed: any[] = await cloudflareApi(`accounts/${accountId}/tokens?per_page=50`);
const existingToken = (name: string) => listed.find((entry) => entry?.name === name && entry?.status === 'active');
const tokenRequest = (name: string, permissionGroupId: string, resources: Record<string, string>) => ({
	name, policies: [{ effect: 'allow', permission_groups: [{ id: permissionGroupId }], resources }],
});
async function ensureToken(name: string, permissionGroupId: string, resources: Record<string, string>) {
	const existing = existingToken(name);
	if (!apply) return { id: existing?.id ? String(existing.id) : null, value: null as string | null, created: false, planned: !existing };
	if (existing && !rotateTokens) return { id: String(existing.id), value: null as string | null, created: false, planned: false };
	if (existing) {
		const rolled: any = await cloudflareApi(`accounts/${accountId}/tokens/${existing.id}/value`, { method: 'PUT' });
		if (!rolled?.value) throw new Error(`Cloudflare did not return the rotated value for ${name}.`);
		return { id: String(existing.id), value: String(rolled.value), created: false, planned: false };
	}
	const created: any = await cloudflareApi(`accounts/${accountId}/tokens`, { method: 'POST', body: JSON.stringify(tokenRequest(name, permissionGroupId, resources)) });
	if (!created?.id || !created?.value) throw new Error(`Cloudflare did not return credentials for ${name}.`);
	return { id: String(created.id), value: String(created.value), created: true, planned: false };
}
const privacyToken = await ensureToken(privacyTokenName, privacyPermissionId, { [accountResource]: '*' });
const publisherToken = await ensureToken(publisherTokenName, publisherPermissionId, { [bucketResource]: '*' });
const currentConfiguration = (() => {
	try { return JSON.parse(readFileSync(configurationPath, 'utf8')) as Record<string, any>; }
	catch (error) {
		if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
		const envelope = JSON.parse(execFileSync('trsd', ['host', 'config', 'show', '--json'], { encoding: 'utf8' })) as any;
		if (envelope?.ok !== true || !envelope?.result) throw new Error('TreeSeed manager configuration could not be read through trsd.');
		return envelope.result as Record<string, any>;
	}
})();
const configurationMutation = Object.values(r2ReplicationSecretIds).some((id) =>
	currentConfiguration.secrets?.[id]?.provider !== 'file'
	|| currentConfiguration.secrets?.[id]?.reference !== `/etc/treeseed/credentials/${id}`);
const candidate = configurationMutation ? addReplicationSecrets(currentConfiguration) : currentConfiguration;
const secretFilesReady = Object.values(r2ReplicationSecretIds).every((id) => existsSync(`/etc/treeseed/credentials/${id}`));
if (apply && (!privacyToken.value || !publisherToken.value) && !secretFilesReady) {
	throw new Error('Cloudflare child tokens already exist but manager credentials are absent; rerun with --rotate-tokens to recover deterministically.');
}
const temporary = mkdtempSync(`${tmpdir()}/treeseed-r2-replication-`);
try {
	const candidatePath = resolve(temporary, 'platform.json');
	writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 });
	if (apply && privacyToken.value && publisherToken.value) {
		const values: Record<string, string> = {
			[r2ReplicationSecretIds.accountId]: accountId,
			[r2ReplicationSecretIds.managementToken]: privacyToken.value,
			[r2ReplicationSecretIds.bucketName]: bucket,
			[r2ReplicationSecretIds.accessKeyId]: publisherToken.id!,
			[r2ReplicationSecretIds.secretAccessKey]: createHash('sha256').update(publisherToken.value).digest('hex'),
		};
		for (const [id, secret] of Object.entries(values)) {
			const source = resolve(temporary, id);
			writeFileSync(source, secret, { mode: 0o600 });
			execFileSync('sudo', ['install', '-o', 'root', '-g', 'root', '-m', '0600', source, `/etc/treeseed/credentials/${id}`], { stdio: 'inherit' });
		}
	}
	if (configurationMutation && apply) execFileSync('trsd', ['host', 'config', 'apply', candidatePath, '--json'], { stdio: 'inherit' });
	else if (configurationMutation) execFileSync('trsd', ['host', 'config', 'plan', candidatePath, '--json'], { stdio: 'inherit' });
	process.stdout.write(`${JSON.stringify({ ok: true, mutation: apply, accountId, teamId, bucket, bucketExists: bucketExists || apply,
		configurationMutation,
		privacy, tokens: { privacy: { name: privacyTokenName, id: privacyToken.id, created: privacyToken.created, planned: privacyToken.planned },
			publisher: { name: publisherTokenName, id: publisherToken.id, created: publisherToken.created, planned: publisherToken.planned } },
		secretIds: Object.values(r2ReplicationSecretIds) })}\n`);
} finally {
	rmSync(temporary, { recursive: true, force: true });
}

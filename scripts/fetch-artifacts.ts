import { createHash } from 'node:crypto';
import { basename, dirname, resolve, sep } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { integrationReleaseSchema, type IntegrationRelease } from '@treeseed/sdk/deployment';

const root = process.cwd(), cache = resolve(root, '.treeseed/artifacts');
const inputs = process.argv.slice(2).length ? process.argv.slice(2) : (process.env.TREESEED_INTEGRATION_RELEASES ?? '').split(',').filter(Boolean);
if (inputs.length === 0) throw new Error('Usage: fetch-artifacts INTEGRATION_RELEASE...');

function digest(value: Uint8Array) { return createHash('sha256').update(value).digest('hex'); }
function safeTarget(relative: string) {
	const path = resolve(cache, relative);
	if (!path.startsWith(`${cache}${sep}`) || relative.includes('..')) throw new Error(`Artifact target escapes the cache: ${relative}.`);
	return path;
}
async function acquire(url: string, sha256: string, relative: string) {
	const allowed = /^https:\/\/(?:github\.com|registry\.npmjs\.org)\//u.test(url)
		|| /^https:\/\/raw\.githubusercontent\.com\/treeseed-ai\/[a-z0-9-]+\/[a-f0-9]{40}\//u.test(url);
	if (!allowed || !/^[a-f0-9]{64}$/u.test(sha256)) throw new Error(`Artifact ${url} has an invalid immutable identity.`);
	const path = safeTarget(relative);
	if (existsSync(path) && digest(readFileSync(path)) === sha256) return path;
	const response = await fetch(url, { redirect: 'follow' });
	if (!response.ok) throw new Error(`Artifact ${url} download failed with ${response.status}.`);
	const value = new Uint8Array(await response.arrayBuffer());
	if (digest(value) !== sha256) throw new Error(`Artifact ${url} digest mismatch.`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(`${path}.new`, value, { mode: 0o644 }); renameSync(`${path}.new`, path);
	return path;
}

const integrations: IntegrationRelease[] = [];
for (const input of inputs) {
	let raw: string;
	if (input.startsWith('https://')) {
		if (!/^https:\/\/raw\.githubusercontent\.com\/treeseed-ai\/platform\/[a-f0-9]{40}\//u.test(input)) throw new Error('Remote integration locks must use an exact Platform commit URL.');
		const response = await fetch(input);
		if (!response.ok) throw new Error(`Integration lock ${input} download failed with ${response.status}.`);
		raw = await response.text();
	} else raw = readFileSync(resolve(input), 'utf8');
	const integration = integrationReleaseSchema.parse(JSON.parse(raw));
	for (const payload of integration.hostPayloads) await acquire(payload.artifact.url, payload.artifact.sha256, `payloads/${payload.id}/${basename(new URL(payload.artifact.url).pathname)}`);
	for (const profile of integration.hostProfiles) await acquire(profile.artifact.url, profile.artifact.sha256, `profiles/${profile.id}/profile.json`);
	for (const component of integration.components) {
		await acquire(component.manifest.url, component.manifest.sha256, `components/${component.componentId}/${component.release}/component-release.json`);
		for (const file of component.files) await acquire(file.artifact.url, file.artifact.sha256, `components/${component.componentId}/${component.release}/${file.path}`);
	}
	mkdirSync(resolve(cache, 'integrations'), { recursive: true });
	writeFileSync(resolve(cache, 'integrations', `${integration.track}.json`), `${JSON.stringify(integration, null, 2)}\n`);
	integrations.push(integration);
}
if (new Set(integrations.map((integration) => integration.track)).size !== integrations.length) throw new Error('Only one integration release per track may be fetched.');
console.log(JSON.stringify({ ok: true, integrations: integrations.map(({ track, release, generation }) => ({ track, release, generation })), cache }));

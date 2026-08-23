import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

interface Artifact { id: string; url: string; sha256: string; target: string }
const root = process.cwd(), cache = resolve(root, '.treeseed/artifacts');
const lock = JSON.parse(readFileSync(resolve(root, 'release/artifacts.lock.json'), 'utf8')) as { schemaVersion: string; artifacts: Artifact[] };
if (lock.schemaVersion !== 'treeseed.deployment-artifacts/v1' || !Array.isArray(lock.artifacts)) throw new Error('Deployment artifact lock is malformed.');

function digest(value: Uint8Array) { return createHash('sha256').update(value).digest('hex'); }
function target(artifact: Artifact) {
	if (!/^[a-z0-9][a-zA-Z0-9._~/-]+$/u.test(artifact.target) || artifact.target.includes('..')) throw new Error(`Unsafe artifact target ${artifact.target}.`);
	const path = resolve(cache, artifact.target);
	if (!path.startsWith(`${cache}${sep}`)) throw new Error(`Artifact ${artifact.id} escapes the cache.`);
	return path;
}

for (const artifact of lock.artifacts) {
	if (!/^https:\/\/(?:github\.com|registry\.npmjs\.org)\//u.test(artifact.url) || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) throw new Error(`Artifact ${artifact.id} has an invalid identity.`);
	const path = target(artifact);
	if (existsSync(path) && digest(readFileSync(path)) === artifact.sha256) continue;
	const response = await fetch(artifact.url, { redirect: 'follow' });
	if (!response.ok) throw new Error(`Artifact ${artifact.id} download failed with ${response.status}.`);
	const value = new Uint8Array(await response.arrayBuffer());
	if (digest(value) !== artifact.sha256) throw new Error(`Artifact ${artifact.id} digest mismatch.`);
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.new`;
	writeFileSync(temporary, value, { mode: 0o644 });
	renameSync(temporary, path);
}
console.log(JSON.stringify({ ok: true, artifacts: lock.artifacts.length, cache }));

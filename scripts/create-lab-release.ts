import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { componentReleaseSchema, deploymentDigest } from '@treeseed/sdk/deployment';

const diagnostics = process.env.TREESEED_DIAGNOSTICS_DIGEST, mailpit = process.env.TREESEED_MAILPIT_DIGEST;
if (![diagnostics, mailpit].every((value) => /^sha256:[a-f0-9]{64}$/u.test(value ?? ''))) throw new Error('Lab publication requires exact read-back image digests.');
const applicationVersion = JSON.parse(readFileSync('package.json', 'utf8')).version as string;
const release = `${applicationVersion.replace(/-rc\.(\d+)$/u, '~rc$1')}-1`;
const compose = readFileSync('deploy/lab/compose.yml', 'utf8').replace('sha256:MAILPIT_DIGEST_REQUIRED', mailpit!).replace('sha256:DIAGNOSTICS_DIGEST_REQUIRED', diagnostics!);
const composeDigest = `sha256:${createHash('sha256').update(compose).digest('hex')}`;
const runtime = {
	schemaVersion: 'treeseed.package-runtime/v1' as const, componentId: 'lab', version: release,
	compose: { projectName: 'treeseed-lab', files: [{ path: 'compose.yml', digest: composeDigest }] },
	services: [
		{ id: 'mailpit', composeService: 'mailpit', endpoints: [
			{ id: 'smtp', protocol: 'tcp' as const, port: 1025, visibility: 'private' as const, aliasOverride: false, tls: 'none' as const, authentication: 'none' as const },
			{ id: 'web', protocol: 'http' as const, port: 8025, visibility: 'host' as const, defaultAlias: 'mail.treeseed.localhost', aliasOverride: true, tls: 'edge' as const, authentication: 'none' as const, healthGate: { protocol: 'http' as const, path: '/api/v1/info', timeoutSeconds: 60 } },
		] },
		{ id: 'diagnostics', composeService: 'diagnostics', endpoints: [{ id: 'http', protocol: 'http' as const, port: 8080, visibility: 'host' as const, defaultAlias: 'lab.treeseed.localhost', aliasOverride: true, tls: 'edge' as const, authentication: 'application' as const, healthGate: { protocol: 'http' as const, path: '/healthz', timeoutSeconds: 60 } }] },
	],
	stateVolumes: [], migrations: [], requiredCapabilities: ['docker-compose'], dependencies: [],
};
const component = componentReleaseSchema.parse({
	schemaVersion: 'treeseed.component-release/v1', componentId: 'lab', release, applicationVersion, revision: 1, track: 'development',
	source: { repository: 'treeseed-ai/deployment', commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() },
	stableBase: { releaseRange: '>=0.1.0 <0.2.0', compatibilityId: 'treeseed-linux-amd64-v1', catalogDigest: null },
	packages: [{ name: 'treeseed-lab', version: release, architecture: 'all', origin: 'TreeSeed Deployment', order: 50 }],
	images: [
		{ role: 'mailpit', repository: 'treeseed/mailpit', digest: mailpit, platforms: ['linux/amd64', 'linux/arm64'], consumers: ['lab'] },
		{ role: 'diagnostics', repository: 'treeseed/diagnostics', digest: diagnostics, platforms: ['linux/amd64', 'linux/arm64'], consumers: ['lab'] },
	],
	runtime, runtimeDigest: deploymentDigest(runtime), rollback: { compatible: true, requiresBackup: false },
	evidence: { provenance: [`https://hub.docker.com/r/treeseed/mailpit/tags?name=${applicationVersion}`, `https://hub.docker.com/r/treeseed/diagnostics/tags?name=${applicationVersion}`], sboms: [`https://hub.docker.com/r/treeseed/mailpit/tags?name=${applicationVersion}`, `https://hub.docker.com/r/treeseed/diagnostics/tags?name=${applicationVersion}`], vulnerabilities: [] },
});
mkdirSync('release/out/lab', { recursive: true });
writeFileSync('release/out/lab/component-release.json', `${JSON.stringify(component, null, 2)}\n`);
writeFileSync('release/out/lab/compose.yml', compose);
console.log(JSON.stringify({ ok: true, release, runtimeDigest: component.runtimeDigest, composeDigest }));

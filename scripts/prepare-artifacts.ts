import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { componentReleaseSchema, deploymentDigest, type ComponentRelease } from '@treeseed/sdk/deployment';
import { sealCatalog } from './compile-catalog.js';

const root = process.cwd(), artifacts = resolve(root, '.treeseed/artifacts');
function readComponent(id: string, release: string) { return componentReleaseSchema.parse(JSON.parse(readFileSync(resolve(artifacts, 'components', id, release, 'component-release.json'), 'utf8'))); }
function write(path: string, value: string) { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, value); }

function stableAgent(): ComponentRelease {
	const development = readComponent('agent', '0.13.0~rc11');
	const runtime = { ...structuredClone(development.runtime), version: '0.12.58' };
	const manager = 'sha256:a037d4b62689ad78f9188b84685b960d112c293b0e070825535171a1cedeb957';
	const runner = 'sha256:ddbf1604e8a5187b190b016bfb311d93402c4d588440881a53c4319facc1aa99';
	const release = componentReleaseSchema.parse({ ...development, release: '0.12.58', track: 'stable', source: { repository: 'treeseed-ai/agent', commit: 'f9ee9441ad0f55debeeb71fac97616e0702b2c1a' }, stableBase: null,
		packages: [{ name: 'treeseed-component-agent', version: '0.12.58', architecture: 'all', origin: 'TreeSeed Deployment', order: 30 }],
		images: development.images.map((image) => ({ ...image, digest: image.role === 'agent-manager' ? manager : runner })), runtime, runtimeDigest: deploymentDigest(runtime),
		evidence: { provenance: ['https://hub.docker.com/r/treeseed/agent-manager/tags?name=0.12.58', 'https://hub.docker.com/r/treeseed/agent-runner/tags?name=0.12.58'], sboms: ['https://hub.docker.com/r/treeseed/agent-manager/tags?name=0.12.58', 'https://hub.docker.com/r/treeseed/agent-runner/tags?name=0.12.58'], vulnerabilities: [] } });
	const source = readFileSync(resolve(artifacts, 'components/agent/0.13.0~rc11/compose.yml'), 'utf8');
	const compose = source.replace(/sha256:ea5259f5ae03099ff692a09570b06cf81d39c13cc8ea2acdf18661f3679ea461/gu, manager).replace(/sha256:7591c1b2eb4a7a70948d030490469d0f5af62f0261f1cb6ab870390c3296999f/gu, runner);
	const directory = resolve(artifacts, 'components/agent/0.12.58');
	write(resolve(directory, 'component-release.json'), `${JSON.stringify(release, null, 2)}\n`);
	write(resolve(directory, 'compose.yml'), compose);
	return release;
}

const stableComponent = stableAgent();
const stable = sealCatalog({ schemaVersion: 'treeseed.release-catalog/v1', release: '0.1.0', generation: 1_000_001, track: 'stable', compatibilityId: 'treeseed-linux-amd64-v1', stableBase: null, components: [stableComponent], createdAt: '2026-08-23T00:00:00.000Z' });
function lab(): ComponentRelease {
	const diagnostics = process.env.TREESEED_DIAGNOSTICS_DIGEST ?? `sha256:${'0'.repeat(64)}`, mailpit = process.env.TREESEED_MAILPIT_DIGEST ?? `sha256:${'0'.repeat(64)}`;
	if (![diagnostics, mailpit].every((value) => /^sha256:[a-f0-9]{64}$/u.test(value))) throw new Error('Lab image digests must be exact SHA-256 identities.');
	if (process.env.TREESEED_REQUIRE_PUBLISHED_IMAGES === '1' && [diagnostics, mailpit].some((value) => value === `sha256:${'0'.repeat(64)}`)) throw new Error('Protected publication requires read-back lab image digests.');
	const runtime = { schemaVersion: 'treeseed.package-runtime/v1' as const, componentId: 'lab', version: '0.1.0~rc12-1', compose: { projectName: 'treeseed-lab', files: ['compose.yml'] }, services: [
		{ id: 'mailpit', composeService: 'mailpit', endpoints: [
			{ id: 'smtp', protocol: 'tcp', port: 1025, visibility: 'private', aliasOverride: false, tls: 'none', authentication: 'none' },
			{ id: 'web', protocol: 'http', port: 8025, visibility: 'host', defaultAlias: 'mail.treeseed.localhost', aliasOverride: true, tls: 'edge', authentication: 'none', healthGate: { protocol: 'http', path: '/api/v1/info', timeoutSeconds: 60 } },
		] },
		{ id: 'diagnostics', composeService: 'diagnostics', endpoints: [{ id: 'http', protocol: 'http', port: 8080, visibility: 'host', defaultAlias: 'lab.treeseed.localhost', aliasOverride: true, tls: 'edge', authentication: 'application', healthGate: { protocol: 'http', path: '/healthz', timeoutSeconds: 60 } }] },
	], stateVolumes: [], migrations: [], requiredCapabilities: ['docker-compose'] };
	const release = componentReleaseSchema.parse({ schemaVersion: 'treeseed.component-release/v1', componentId: 'lab', release: runtime.version, track: 'development', source: { repository: 'treeseed-ai/deployment', commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }, stableBase: { releaseRange: '>=0.1.0 <0.2.0', compatibilityId: stable.compatibilityId, catalogDigest: stable.catalogDigest }, packages: [{ name: 'treeseed-lab', version: runtime.version, architecture: 'all', origin: 'TreeSeed Deployment', order: 50 }], images: [
		{ role: 'mailpit', repository: 'treeseed/mailpit', digest: mailpit, platforms: ['linux/amd64', 'linux/arm64'], consumers: ['lab'] },
		{ role: 'diagnostics', repository: 'treeseed/diagnostics', digest: diagnostics, platforms: ['linux/amd64', 'linux/arm64'], consumers: ['lab'] },
	], runtime, runtimeDigest: deploymentDigest(runtime), rollback: { compatible: true, requiresBackup: false }, evidence: { provenance: ['https://hub.docker.com/r/treeseed/mailpit/tags?name=0.1.0-rc.10', 'https://hub.docker.com/r/treeseed/diagnostics/tags?name=0.1.0-rc.10'], sboms: ['https://hub.docker.com/r/treeseed/mailpit/tags?name=0.1.0-rc.10', 'https://hub.docker.com/r/treeseed/diagnostics/tags?name=0.1.0-rc.10'], vulnerabilities: [] } });
	const compose = readFileSync(resolve(root, 'deploy/lab/compose.yml'), 'utf8').replace('sha256:MAILPIT_DIGEST_REQUIRED', mailpit).replace('sha256:DIAGNOSTICS_DIGEST_REQUIRED', diagnostics);
	const directory = resolve(artifacts, 'components/lab', runtime.version);
	write(resolve(directory, 'component-release.json'), `${JSON.stringify(release, null, 2)}\n`); write(resolve(directory, 'compose.yml'), compose);
	return release;
}
const developmentComponents = [['agent', '0.13.0~rc13'], ['api', '0.8.0~rc9'], ['treedx', '0.3.0~rc5']].map(([id, release]) => {
	const component = readComponent(id!, release!);
	return componentReleaseSchema.parse({ ...component, stableBase: { ...component.stableBase!, catalogDigest: stable.catalogDigest } });
});
developmentComponents.push(lab());
const development = sealCatalog({ schemaVersion: 'treeseed.release-catalog/v1', release: '0.1.0~rc12', generation: 1_000_013, track: 'development', compatibilityId: stable.compatibilityId, stableBase: { release: stable.release, catalogDigest: stable.catalogDigest }, components: developmentComponents, createdAt: '2026-08-24T03:00:00.000Z' });
write(resolve(artifacts, 'catalogs/stable.json'), `${JSON.stringify(stable, null, 2)}\n`);
write(resolve(artifacts, 'catalogs/development.json'), `${JSON.stringify(development, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, stable: stable.catalogDigest, development: development.catalogDigest, components: development.components.map((component) => component.componentId) }));

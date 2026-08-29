import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { componentReleaseSchema, hostConfigurationSchema, hostNeedsEdge, integrationReleaseSchema, type IntegrationRelease } from '@treeseed/sdk/deployment';

interface Definition { architecture: 'all' | 'amd64'; depends: string; description: string; packageName?: string; version?: string; replaces?: string; breaks?: string; payload?: (stage: string) => void; postinst?: string }
const root = process.cwd(), output = resolve(root, 'release/out'), cache = resolve(root, '.treeseed/cache'), artifacts = resolve(root, '.treeseed/artifacts');
const npmVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version as string;
const deploymentVersion = process.env.TREESEED_DEBIAN_VERSION ?? npmVersion.replace(/-rc\.(\d+)$/u, '~rc$1') + '-1';
const aptSuite = process.env.TREESEED_APT_SUITE;
if (aptSuite !== undefined && aptSuite !== 'stable' && aptSuite !== 'development') throw new Error('TREESEED_APT_SUITE must be stable or development.');
const stableCatalog = JSON.parse(readFileSync(resolve(artifacts, 'catalogs/stable.json'), 'utf8')) as { release: string; generation: number };
const stableCatalogRelease = stableCatalog.release;
if (!/^\d+\.\d+\.\d+$/u.test(stableCatalogRelease)) throw new Error('Stable catalog release is not a Debian-compatible version.');
if (!Number.isInteger(stableCatalog.generation) || stableCatalog.generation < 1) throw new Error('Stable catalog generation is not a positive integer.');
const stableCatalogVersion = `${stableCatalogRelease}-${stableCatalog.generation}`;
function readIntegration(track: 'stable' | 'development') {
	const path = resolve(artifacts, 'integrations', `${track}.json`);
	return existsSync(path) ? integrationReleaseSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) : undefined;
}
const stableIntegration = readIntegration('stable'), developmentIntegration = readIntegration('development');
function debianVersion(version: string) { return version.replace(/-rc\.(\d+)$/u, '~rc$1') + (/-\d+$/u.test(version) ? '' : '-1'); }
function selectedIntegration() {
	const integration = aptSuite === 'stable' ? stableIntegration : developmentIntegration;
	if (!integration) throw new Error(`The ${aptSuite ?? 'requested'} integration lock has not been fetched.`);
	return integration;
}
function hostPayload(id: string, integration: IntegrationRelease) {
	const payload = integration.hostPayloads.find((candidate) => candidate.id === id);
	if (!payload) throw new Error(`Integration ${integration.track}@${integration.release} does not select host payload ${id}.`);
	return { ...payload, archive: resolve(artifacts, 'payloads', id, basename(new URL(payload.artifact.url).pathname)) };
}
function directory(path: string) { mkdirSync(path, { recursive: true }); }
function install(source: string, target: string, mode?: number) { directory(resolve(target, '..')); copyFileSync(resolve(root, source), target); if (mode) chmodSync(target, mode); }
function unit(stage: string, name: string) { install(`systemd/${name}`, resolve(stage, `usr/lib/systemd/system/${name}`)); }
function extractNpm(archive: string, target: string) { directory(target); execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', target]); }
function normalize(path: string) {
	const stat = lstatSync(path);
	if (stat.isDirectory()) for (const name of readdirSync(path)) normalize(resolve(path, name));
	if (!stat.isSymbolicLink()) chmodSync(path, stat.mode & ~0o022);
}
function managerPayload(stage: string) {
	directory(resolve(stage, 'usr/lib/treeseed/manager'));
	cpSync(resolve(root, 'dist/src'), resolve(stage, 'usr/lib/treeseed/manager/dist/src'), { recursive: true });
	writeFileSync(resolve(stage, 'usr/lib/treeseed/manager/package.json'), '{"type":"module"}\n');
	for (const dependency of ['@treeseed/sdk', 'yaml', 'zod']) {
		const source = resolve(root, 'node_modules', dependency);
		if (!existsSync(source)) throw new Error(`Runtime dependency ${dependency} is not installed.`);
		cpSync(source, resolve(stage, 'usr/lib/treeseed/manager/node_modules', dependency), { recursive: true });
	}
	for (const name of ['treeseed-manager-supervisor.service', 'treeseed-provider-volume.service', 'treeseed-sandbox-broker.service', 'treeseed-manager-api.service', 'treeseed-manager-reconcile.service', 'treeseed-manager-stable.service', 'treeseed-manager-stable.timer', 'treeseed-manager-development.service', 'treeseed-manager-development.timer', 'treeseed-manager-apt-helper.service', 'treeseed-manager-restart.service']) unit(stage, name);
	directory(resolve(stage, 'usr/lib/treeseed/manager/bin'));
	install('scripts/bootstrap/initialize-pki.sh', resolve(stage, 'usr/lib/treeseed/manager/bin/initialize-pki'), 0o755);
}
function hostRuntime(stage: string) {
	const manifest = JSON.parse(readFileSync(resolve(root, 'release/host-js-runtime.json'), 'utf8')) as { url: string; sha256: string };
	directory(cache); const archive = resolve(cache, basename(manifest.url));
	if (!existsSync(archive)) execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '--output', archive, manifest.url], { stdio: 'inherit' });
	if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== manifest.sha256) throw new Error('Pinned host Node runtime checksum mismatch.');
	directory(resolve(stage, 'usr/lib/treeseed/runtime'));
	execFileSync('tar', ['-xJf', archive, '--strip-components=1', '-C', resolve(stage, 'usr/lib/treeseed/runtime')]);
	for (const name of ['npm', 'npx', 'corepack']) rmSync(resolve(stage, `usr/lib/treeseed/runtime/bin/${name}`), { force: true });
}
function kataRuntime(stage: string) {
	const manifest = JSON.parse(readFileSync(resolve(root, 'release/kata-runtime.json'), 'utf8')) as { version: string; architecture: string; url: string; size: number; sha256: string };
	const expectedUrl = `https://github.com/kata-containers/kata-containers/releases/download/${manifest.version}/kata-static-${manifest.version}-amd64.tar.zst`;
	if (manifest.architecture !== 'amd64' || !/^4\.[0-9]+\.[0-9]+$/u.test(manifest.version) || manifest.url !== expectedUrl || !Number.isSafeInteger(manifest.size) || manifest.size < 100_000_000 || !/^[a-f0-9]{64}$/u.test(manifest.sha256)) throw new Error('Pinned Kata runtime manifest is invalid.');
	directory(resolve(stage, 'usr/share/treeseed'));
	writeFileSync(resolve(stage, 'usr/share/treeseed/kata-runtime.env'), [
		`TREESEED_KATA_VERSION='${manifest.version}'`, `TREESEED_KATA_URL='${manifest.url}'`, `TREESEED_KATA_SIZE='${manifest.size}'`, `TREESEED_KATA_SHA256='${manifest.sha256}'`, '',
	].join('\n'), { mode: 0o644 });
}
function component(id: string, release: string): Definition {
	const source = resolve(artifacts, 'components', id, release), manifest = JSON.parse(readFileSync(resolve(source, 'component-release.json'), 'utf8')) as { componentId?: string; release?: string };
	if (manifest.componentId !== id || manifest.release !== release) throw new Error(`Locked ${id} component identity does not match its package.`);
	const accepted = componentReleaseSchema.parse(manifest), declaredPackage = accepted.packages[0];
	if (!declaredPackage) throw new Error(`Component ${id}@${release} does not declare a Debian package.`);
	return { architecture: declaredPackage.architecture, packageName: declaredPackage.name, version: declaredPackage.version, depends: 'treeseed-manager', description: `Exact runtime bundle for the TreeSeed ${id} component`, payload(stage) {
		cpSync(source, resolve(stage, `usr/share/treeseed/components/${id}/${release}`), { recursive: true });
		const configurationRoot = `/etc/treeseed/components/${id}`;
		writeFileSync(resolve(stage, 'DEBIAN/postinst'), `#!/bin/sh\nset -eu\ninstall -d -o root -g treeseed-manager -m 0750 ${configurationRoot}\nif [ ! -e ${configurationRoot}/environment ]; then install -o root -g treeseed-manager -m 0640 /dev/null ${configurationRoot}/environment; fi\nexit 0\n`, { mode: 0o755 });
	} };
}
function componentDefinitions(integration: IntegrationRelease) {
	return Object.fromEntries(integration.components.map(({ componentId, release }) => [`treeseed-component-${componentId}`, component(componentId, release)]));
}
const packageIntegration = aptSuite ? selectedIntegration() : developmentIntegration ?? stableIntegration;
const sdkPayload = packageIntegration && hostPayload('sdk', packageIntegration);
const cliPayload = packageIntegration && hostPayload('cli', packageIntegration);
const cliPackageVersion = cliPayload ? `${debianVersion(cliPayload.version).replace(/-1$/u, '-2')}+deployment${deploymentVersion.replace(/-1$/u, '')}` : deploymentVersion;
function writeBootstrapEdgePolicy(stage: string, configurationPath: string) {
	if (!packageIntegration) throw new Error('A configured bootstrap requires an integration lock.');
	const configuration = hostConfigurationSchema.parse(JSON.parse(readFileSync(configurationPath, 'utf8')));
	const releases = packageIntegration.components.map(({ componentId, release }) => componentReleaseSchema.parse(JSON.parse(readFileSync(resolve(artifacts, 'components', componentId, release, 'component-release.json'), 'utf8'))));
	if (configuration.network.manager.aliases.length || hostNeedsEdge(configuration, releases)) {
		directory(resolve(stage, 'usr/share/treeseed/bootstrap'));
		writeFileSync(resolve(stage, 'usr/share/treeseed/bootstrap/install-edge'), 'required\n');
	}
}
const packages: Record<string, Definition> = {
	'treeseed': { architecture: 'amd64', depends: 'systemd, ca-certificates, curl, gnupg, openssl, jq, apt (>= 2.4)', description: 'Configured TreeSeed host bootstrap and seeder', postinst: 'debian/bootstrap/postinst', payload(stage) { directory(resolve(stage, 'var/lib/treeseed/bootstrap/seed')); const configuration = process.env.TREESEED_CONFIGURATION_FILE; if (!configuration) throw new Error('treeseed bootstrap packages must be built with TREESEED_CONFIGURATION_FILE.'); copyFileSync(resolve(configuration), resolve(stage, 'var/lib/treeseed/bootstrap/seed/platform.json')); chmodSync(resolve(stage, 'var/lib/treeseed/bootstrap/seed/platform.json'), 0o600); writeBootstrapEdgePolicy(stage, resolve(configuration)); const credentials = process.env.TREESEED_CREDENTIALS_FILE; if (credentials) { copyFileSync(resolve(credentials), resolve(stage, 'var/lib/treeseed/bootstrap/seed/credentials.json')); chmodSync(resolve(stage, 'var/lib/treeseed/bootstrap/seed/credentials.json'), 0o600); } const operator = process.env.TREESEED_OPERATOR_USER; if (operator) { if (!/^[a-zA-Z0-9._-]+$/u.test(operator) || operator === 'root') throw new Error('Configured operator username is invalid.'); writeFileSync(resolve(stage, 'var/lib/treeseed/bootstrap/seed/operator'), `${operator}\n`, { mode: 0o600 }); } const reset = process.env.TREESEED_RESET_UNACCEPTED_COMPONENTS; if (reset) { const components = reset.split(','); if (components.some((componentId) => !/^[a-z][a-z0-9.-]+$/u.test(componentId)) || new Set(components).size !== components.length) throw new Error('Unaccepted component reset list is invalid.'); writeFileSync(resolve(stage, 'var/lib/treeseed/bootstrap/seed/reset-unaccepted-components.json'), `${JSON.stringify(components)}\n`, { mode: 0o600 }); } directory(resolve(stage, 'usr/share/treeseed/bootstrap/keyrings')); for (const file of ['stable.sources', 'development.sources', 'preferences.stable', 'preferences.development']) install(`deploy/bootstrap/${file}`, resolve(stage, `usr/share/treeseed/bootstrap/${file}`)); for (const track of ['stable', 'development']) install(`release/apt/${track}.asc`, resolve(stage, `usr/share/treeseed/bootstrap/keyrings/treeseed-deployment-${track}.asc`)); for (const track of ['stable', 'development']) execFileSync('gpg', ['--batch', '--yes', '--dearmor', '--output', resolve(stage, `usr/share/treeseed/bootstrap/keyrings/treeseed-deployment-${track}.gpg`), resolve(root, `release/apt/${track}.asc`)]); writeFileSync(resolve(stage, 'usr/share/treeseed/bootstrap/suite'), process.env.TREESEED_BOOTSTRAP_SUITE === 'stable' ? 'stable\n' : 'development\n'); install('scripts/bootstrap/bootstrap.sh', resolve(stage, 'usr/lib/treeseed/bootstrap/bootstrap.sh'), 0o755); unit(stage, 'treeseed-bootstrap.service'); } },
	'treeseed-host-runtime': { architecture: 'amd64', depends: 'libc6 (>= 2.36), libstdc++6, ca-certificates, docker.io | docker-ce, docker-compose-v2 | docker-compose-plugin', description: 'Private pinned Node 24 and container host runtime for TreeSeed', payload: hostRuntime },
	'treeseed-kata-runtime': { architecture: 'amd64', depends: 'containerd (>= 2.0), qemu-system-x86, zstd, curl, ca-certificates', description: 'Pinned Kata runtime-rs QEMU/KVM host runtime for TreeSeed assignment sandboxes', postinst: 'debian/kata-runtime/postinst', payload: kataRuntime },
	'treeseed-manager': { architecture: 'amd64', depends: `treeseed-host-runtime (= ${deploymentVersion}), treeseed-kata-runtime (= ${deploymentVersion}), treeseed-sdk (= ${sdkPayload ? debianVersion(sdkPayload.version) : deploymentVersion}), treeseed-cli (= ${cliPackageVersion}), util-linux, iproute2, containerd, containernetworking-plugins, nftables, openssl, cryptsetup (>= 2:2.6), rsync`, description: 'TreeSeed host manager, reconciler, Kata sandbox broker, and fixed root supervisor', postinst: 'debian/manager/postinst', payload: managerPayload },
	'treeseed-sdk': { architecture: 'all', ...(sdkPayload ? { version: debianVersion(sdkPayload.version) } : {}), depends: '', description: 'Accepted TreeSeed SDK host contracts and CLI runtime dependencies', payload(stage) {
		if (!sdkPayload) throw new Error('No integration lock selects the SDK host payload.');
		const modules = resolve(stage, 'usr/lib/treeseed/cli/node_modules');
		extractNpm(sdkPayload.archive, resolve(modules, '@treeseed/sdk'));
		for (const [id, target] of [['treedx', '@treeseed/treedx'], ['yaml', 'yaml'], ['zod', 'zod']] as const) {
			const payload = hostPayload(id, packageIntegration!);
			extractNpm(payload.archive, resolve(modules, target));
		}
		cpSync(resolve(modules, '@treeseed/sdk'), resolve(stage, 'usr/share/treeseed/sdk'), { recursive: true });
	} },
	'treeseed-cli': { architecture: 'all', version: cliPackageVersion, depends: `treeseed-sdk (= ${sdkPayload ? debianVersion(sdkPayload.version) : deploymentVersion}), treeseed-host-runtime`, description: 'TreeSeed trsd host client payload', payload(stage) {
		if (!cliPayload) throw new Error('No integration lock selects the CLI host payload.');
		extractNpm(cliPayload.archive, resolve(stage, 'usr/lib/treeseed/cli'));
		install('scripts/cli-wrapper.sh', resolve(stage, 'usr/bin/trsd'), 0o755);
	} },
	'treeseed-release-catalog': { architecture: 'all', version: stableCatalogVersion, depends: '', description: 'Signed compatible TreeSeed stable-base release catalog', payload(stage) { directory(resolve(stage, 'usr/share/treeseed/catalogs')); copyFileSync(resolve(artifacts, 'catalogs/stable.json'), resolve(stage, 'usr/share/treeseed/catalogs/stable.json')); } },
	'treeseed-release-catalog-development': { architecture: 'all', depends: `treeseed-release-catalog (= ${stableCatalogVersion})`, replaces: `treeseed-release-catalog (<< ${stableCatalogVersion})`, breaks: `treeseed-release-catalog (<< ${stableCatalogVersion})`, description: 'Signed compatible TreeSeed development release overlay', payload(stage) { directory(resolve(stage, 'usr/share/treeseed/catalogs')); copyFileSync(resolve(artifacts, 'catalogs/development.json'), resolve(stage, 'usr/share/treeseed/catalogs/development.json')); } },
	'treeseed-edge': { architecture: 'all', depends: 'docker.io | docker-ce, docker-compose-v2 | docker-compose-plugin', description: 'Manager-owned TreeSeed Caddy edge and local TLS aliases', postinst: 'debian/edge/postinst', payload(stage) { unit(stage, 'treeseed-edge.service'); directory(resolve(stage, 'etc/treeseed/edge')); writeFileSync(resolve(stage, 'etc/treeseed/edge/Caddyfile'), ':443 {\n\tabort\n}\n'); install('deploy/edge/compose.yml', resolve(stage, 'usr/share/treeseed/edge/compose.yml')); install('scripts/edge/ensure-network.sh', resolve(stage, 'usr/lib/treeseed/edge/bin/ensure-network'), 0o755); } },
	...(packageIntegration ? componentDefinitions(packageIntegration) : {}),
};
packages['treeseed-ai'] = {
	...packages.treeseed!,
	description: 'Configured standalone TreeAI bootstrap and unified Deployment seeder',
	replaces: 'treeseed',
	breaks: 'treeseed',
};
function build(name: string, definition: Definition, clean = true) {
	name = definition.packageName ?? name;
	const stage = resolve(output, '.stage', name); rmSync(stage, { recursive: true, force: true }); directory(resolve(stage, 'DEBIAN'));
	const packageVersion = definition.version ?? deploymentVersion;
	if (clean) for (const stale of readdirSync(output).filter((candidate) => candidate.startsWith(`${name}_`) && candidate.endsWith('.deb'))) rmSync(resolve(output, stale), { force: true });
	const control = [`Package: ${name}`, `Version: ${packageVersion}`, 'Section: admin', 'Priority: optional', `Architecture: ${definition.architecture}`, 'Maintainer: TreeSeed Releases <releases@treeseed.ai>', ...(definition.depends ? [`Depends: ${definition.depends}`] : []), ...(definition.replaces ? [`Replaces: ${definition.replaces}`] : []), ...(definition.breaks ? [`Breaks: ${definition.breaks}`] : []), `Description: ${definition.description}`, ' Managed by the unified TreeSeed deployment system.', ''].join('\n');
	writeFileSync(resolve(stage, 'DEBIAN/control'), control);
	if (definition.postinst) install(definition.postinst, resolve(stage, 'DEBIAN/postinst'), 0o755);
	definition.payload?.(stage);
	normalize(stage);
	const target = resolve(output, `${name}_${packageVersion}_${definition.architecture}.deb`); rmSync(target, { force: true });
	execFileSync('dpkg-deb', ['--build', '--root-owner-group', stage, target], { stdio: 'inherit' });
}
directory(output); const requested = process.argv[2] ?? 'all';
if (requested === 'all') {
	const entries = Object.entries(packages).filter(([name]) => !['treeseed', 'treeseed-ai'].includes(name) && (aptSuite !== 'stable' || name !== 'treeseed-release-catalog-development'));
	for (const stale of readdirSync(output).filter((candidate) => candidate.endsWith('.deb'))) rmSync(resolve(output, stale), { force: true });
	for (const [name, definition] of entries) build(name, definition, false);
}
else { const definition = packages[requested]; if (!definition) throw new Error(`Unknown Debian package ${requested}.`); build(requested, definition); }

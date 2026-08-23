import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

interface Definition { architecture: 'all' | 'amd64'; depends: string; description: string; payload?: (stage: string) => void; postinst?: string }
const root = process.cwd(), output = resolve(root, 'release/out'), cache = resolve(root, '.treeseed/cache');
const npmVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version as string;
const version = process.env.TREESEED_DEBIAN_VERSION ?? npmVersion.replace(/-rc\.(\d+)$/u, '~rc$1') + '-1';
function directory(path: string) { mkdirSync(path, { recursive: true }); }
function install(source: string, target: string, mode?: number) { directory(resolve(target, '..')); copyFileSync(resolve(root, source), target); if (mode) chmodSync(target, mode); }
function unit(stage: string, name: string) { install(`systemd/${name}`, resolve(stage, `usr/lib/systemd/system/${name}`)); }
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
	for (const name of ['treeseed-manager-supervisor.service', 'treeseed-manager-api.service', 'treeseed-manager-reconcile.service', 'treeseed-manager-stable.service', 'treeseed-manager-stable.timer', 'treeseed-manager-development.service', 'treeseed-manager-development.timer', 'treeseed-manager-apt-helper.service']) unit(stage, name);
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
const component = (id: string): Definition => ({ architecture: 'all', depends: 'treeseed-manager (= ' + version + ')', description: `Exact runtime bundle for the TreeSeed ${id} component`, payload(stage) { directory(resolve(stage, `usr/share/treeseed/components/${id}`)); writeFileSync(resolve(stage, `usr/share/treeseed/components/${id}/README`), 'Populated only from a verified component-release bundle.\n'); } });
const packages: Record<string, Definition> = {
	'treeseed': { architecture: 'amd64', depends: 'systemd, ca-certificates, curl, gnupg, openssl, jq, apt (>= 2.4)', description: 'Configured TreeSeed host bootstrap and seeder', postinst: 'debian/bootstrap/postinst', payload(stage) { directory(resolve(stage, 'var/lib/treeseed/bootstrap/seed')); const configuration = process.env.TREESEED_CONFIGURATION_FILE; if (!configuration) throw new Error('treeseed bootstrap packages must be built with TREESEED_CONFIGURATION_FILE.'); copyFileSync(resolve(configuration), resolve(stage, 'var/lib/treeseed/bootstrap/seed/platform.json')); chmodSync(resolve(stage, 'var/lib/treeseed/bootstrap/seed/platform.json'), 0o600); const credentials = process.env.TREESEED_CREDENTIALS_FILE; if (credentials) { copyFileSync(resolve(credentials), resolve(stage, 'var/lib/treeseed/bootstrap/seed/credentials.json')); chmodSync(resolve(stage, 'var/lib/treeseed/bootstrap/seed/credentials.json'), 0o600); } directory(resolve(stage, 'usr/share/treeseed/bootstrap/keyrings')); for (const file of ['stable.sources', 'development.sources', 'preferences']) install(`deploy/bootstrap/${file}`, resolve(stage, `usr/share/treeseed/bootstrap/${file}`)); for (const track of ['stable', 'development']) install(`release/apt/${track}.asc`, resolve(stage, `usr/share/treeseed/bootstrap/keyrings/treeseed-deployment-${track}.asc`)); for (const track of ['stable', 'development']) execFileSync('gpg', ['--batch', '--yes', '--dearmor', '--output', resolve(stage, `usr/share/treeseed/bootstrap/keyrings/treeseed-deployment-${track}.gpg`), resolve(root, `release/apt/${track}.asc`)]); writeFileSync(resolve(stage, 'usr/share/treeseed/bootstrap/suite'), process.env.TREESEED_BOOTSTRAP_SUITE === 'stable' ? 'stable\n' : 'development\n'); install('scripts/bootstrap/bootstrap.sh', resolve(stage, 'usr/lib/treeseed/bootstrap/bootstrap.sh'), 0o755); unit(stage, 'treeseed-bootstrap.service'); } },
	'treeseed-host-runtime': { architecture: 'amd64', depends: 'libc6 (>= 2.36), libstdc++6, ca-certificates, docker.io | docker-ce, docker-compose-v2 | docker-compose-plugin', description: 'Private pinned Node 24 and container host runtime for TreeSeed', payload: hostRuntime },
	'treeseed-manager': { architecture: 'amd64', depends: `treeseed-host-runtime (= ${version})`, description: 'TreeSeed host manager, reconciler, mTLS API, and fixed root supervisor', postinst: 'debian/manager/postinst', payload: managerPayload },
	'treeseed-sdk': { architecture: 'all', depends: '', description: 'Accepted TreeSeed SDK host contracts', payload(stage) { cpSync(resolve(root, 'node_modules/@treeseed/sdk'), resolve(stage, 'usr/share/treeseed/sdk'), { recursive: true }); } },
	'treeseed-cli': { architecture: 'all', depends: 'treeseed-sdk', description: 'TreeSeed trsd host client payload' },
	'treeseed-release-catalog': { architecture: 'all', depends: '', description: 'Signed compatible TreeSeed release catalogs', payload(stage) { directory(resolve(stage, 'usr/share/treeseed/catalogs')); for (const track of ['stable', 'development']) install(`release/catalogs/${track}.json`, resolve(stage, `usr/share/treeseed/catalogs/${track}.json`)); } },
	'treeseed-edge': { architecture: 'all', depends: 'docker.io | docker-ce, docker-compose-v2 | docker-compose-plugin', description: 'Manager-owned TreeSeed Caddy edge and local TLS aliases', postinst: 'debian/edge/postinst', payload(stage) { unit(stage, 'treeseed-edge.service'); directory(resolve(stage, 'etc/treeseed/edge')); writeFileSync(resolve(stage, 'etc/treeseed/edge/Caddyfile'), ':443 { abort }\n'); install('deploy/edge/compose.yml', resolve(stage, 'usr/share/treeseed/edge/compose.yml')); install('scripts/edge/ensure-network.sh', resolve(stage, 'usr/lib/treeseed/edge/bin/ensure-network'), 0o755); } },
	'treeseed-component-api': component('api'), 'treeseed-component-agent': component('agent'), 'treeseed-component-treedx': component('treedx'), 'treeseed-component-ai': component('ai'),
	'treeseed-lab': { ...component('lab'), depends: `treeseed-manager (= ${version}), treeseed-edge (= ${version})`, description: 'Optional TreeSeed development mail and read-only diagnostics services', payload(stage) { directory(resolve(stage, 'usr/share/treeseed/components/lab')); install('deploy/lab/compose.yml', resolve(stage, 'usr/share/treeseed/components/lab/compose.yml')); } },
};
function build(name: string, definition: Definition) {
	const stage = resolve(output, '.stage', name); rmSync(stage, { recursive: true, force: true }); directory(resolve(stage, 'DEBIAN'));
	const control = [`Package: ${name}`, `Version: ${version}`, 'Section: admin', 'Priority: optional', `Architecture: ${definition.architecture}`, 'Maintainer: TreeSeed Releases <releases@treeseed.ai>', ...(definition.depends ? [`Depends: ${definition.depends}`] : []), `Description: ${definition.description}`, ' Managed by the unified TreeSeed deployment system.', ''].join('\n');
	writeFileSync(resolve(stage, 'DEBIAN/control'), control);
	if (definition.postinst) install(definition.postinst, resolve(stage, 'DEBIAN/postinst'), 0o755);
	definition.payload?.(stage);
	normalize(stage);
	const target = resolve(output, `${name}_${version}_${definition.architecture}.deb`); rmSync(target, { force: true });
	execFileSync('dpkg-deb', ['--build', '--root-owner-group', stage, target], { stdio: 'inherit' });
}
directory(output); const requested = process.argv[2] ?? 'all';
if (requested === 'all') for (const [name, definition] of Object.entries(packages).filter(([name]) => name !== 'treeseed')) build(name, definition);
else { const definition = packages[requested]; if (!definition) throw new Error(`Unknown Debian package ${requested}.`); build(requested, definition); }

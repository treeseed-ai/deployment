import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { componentReleaseSchema, deploymentDigest, integrationReleaseSchema, releaseCatalogSchema } from '@treeseed/sdk/deployment';

const output = resolve('release/out');
const aptSuite = process.env.TREESEED_APT_SUITE;
if (aptSuite !== 'stable' && aptSuite !== 'development') throw new Error('TREESEED_APT_SUITE must be stable or development.');
const integration = integrationReleaseSchema.parse(JSON.parse(readFileSync(resolve('.treeseed/artifacts/integrations', `${aptSuite}.json`), 'utf8')));
const selected = integration.components.map(({ componentId, release }) => componentReleaseSchema.parse(JSON.parse(readFileSync(resolve('.treeseed/artifacts/components', componentId, release, 'component-release.json'), 'utf8'))));
const core = ['treeseed', 'treeseed-host-runtime', 'treeseed-manager', 'treeseed-sdk', 'treeseed-cli', 'treeseed-release-catalog', 'treeseed-edge', 'treeseed-kata-runtime'];
if (aptSuite === 'development') core.push('treeseed-release-catalog-development');
const componentPackages = selected.flatMap((component) => component.packages.map((item) => item.name));
const expected = [...new Set([...core, ...componentPackages])];
const files = readdirSync(output).filter((name) => name.endsWith('.deb'));
if (files.length !== expected.length) throw new Error(`Expected exactly ${expected.length} suite artifacts; found ${files.length}.`);
const runtime = readdirSync(output).find((name) => /^treeseed-deployment-runtime-.+\.tgz$/u.test(name));
if (!runtime) throw new Error('Deployment runtime package is missing.');
const runtimeFiles = execFileSync('tar', ['-tzf', resolve(output, runtime)], { encoding: 'utf8' }).split('\n');
for (const path of ['package/dist/src/infrastructure/opentofu/index.js', 'package/infrastructure/opentofu/hosted-topology/.terraform.lock.hcl', 'package/infrastructure/opentofu/hosted-topology/main.tf']) {
	if (!runtimeFiles.includes(path)) throw new Error(`Deployment runtime package is missing ${path}.`);
}

const packageFile = (name: string) => {
	const matches = files.filter((candidate) => candidate.startsWith(`${name}_`));
	if (matches.length !== 1) throw new Error(`Expected one Debian artifact for ${name}; found ${matches.length}.`);
	return matches[0]!;
};
const field = (file: string, name: string) => execFileSync('dpkg-deb', ['--field', resolve(output, file), name], { encoding: 'utf8' }).trim();
const fileOwners = new Map<string, string>();
for (const name of expected) {
	const file = packageFile(name);
	if (field(file, 'Package') !== name) throw new Error(`${file} declares an unexpected package identity.`);
	if (componentPackages.includes(name) && /treeseed-(?:manager|edge)\s*\(/u.test(field(file, 'Depends'))) throw new Error(`${file} forces a core package version.`);
	for (const line of execFileSync('dpkg-deb', ['--contents', resolve(output, file)], { encoding: 'utf8' }).split('\n').filter(Boolean)) {
		const mode = line.slice(0, 10);
		if (mode[0] !== 'l' && (mode[5] === 'w' || mode[8] === 'w')) throw new Error(`${file} contains a group/world-writable path: ${line}`);
		if (line.endsWith(' ./') && mode !== 'drwxr-xr-x') throw new Error(`${file} has a nonstandard package root mode: ${line}`);
		if (name === 'treeseed' && mode[0] === 'd' && mode !== 'drwxr-xr-x') throw new Error(`${file} has an unreadable generic-bootstrap directory: ${line}`);
		if (name === 'treeseed' && mode[0] === '-' && mode[7] !== 'r' && mode !== '-rwxr-xr-x') throw new Error(`${file} has an unreadable generic-bootstrap file: ${line}`);
		if (mode[0] !== 'd') {
			const pathStart = line.indexOf(' ./');
			if (pathStart < 0) throw new Error(`${file} contains an unreadable archive entry: ${line}`);
			const path = line.slice(pathStart + 1).split(' -> ', 1)[0]!;
			const owner = fileOwners.get(path);
			if (owner) throw new Error(`${file} and ${owner} both own ${path}.`);
			fileOwners.set(path, file);
		}
	}
}
for (const component of selected) for (const declared of component.packages) {
	if (field(packageFile(declared.name), 'Version') !== declared.version) throw new Error(`${declared.name} does not use integration-selected version ${declared.version}.`);
}

const root = mkdtempSync(resolve(tmpdir(), 'treeseed-deb-proof-'));
try {
	for (const name of ['treeseed', 'treeseed-host-runtime', 'treeseed-manager', 'treeseed-sdk', 'treeseed-cli', 'treeseed-release-catalog', ...(aptSuite === 'development' ? ['treeseed-release-catalog-development'] : []), ...componentPackages]) execFileSync('dpkg-deb', ['--extract', resolve(output, packageFile(name)), root]);
	if (existsSync(resolve(root,'usr/share/treeseed/components/provider-custody-maintenance'))) throw new Error('Retired provider maintenance payload must not be packaged.');
	for (const forbidden of ['var/lib/treeseed/bootstrap/seed/platform.json', 'var/lib/treeseed/bootstrap/seed/credentials.json', 'var/lib/treeseed/bootstrap/seed/operator']) if (existsSync(resolve(root, forbidden))) throw new Error(`Generic bootstrap embeds forbidden host input ${forbidden}.`);
	const bootstrap = readFileSync(resolve(root, 'usr/lib/treeseed/bootstrap/bootstrap.sh'), 'utf8');
	if (bootstrap.includes('/etc/treeseed/platform.json') || bootstrap.includes('credentials.json') || bootstrap.includes('treeseed-component-')) throw new Error('Generic bootstrap contains configured host or component activation behavior.');
	execFileSync(resolve(root, 'usr/lib/treeseed/runtime/bin/node'), [resolve(root, 'usr/lib/treeseed/cli/dist/cli/main.js'), 'host', 'status', '--help'], { encoding: 'utf8' });
	for (const module of ['operator-contracts/operation-builder.js', 'secrets-capability/secret-contracts.js', 'secrets-capability/github-actions-encryption.js', 'standards/typescript/extract.js']) execFileSync(resolve(root, 'usr/lib/treeseed/runtime/bin/node'), ['--input-type=module', '--eval', `await import(${JSON.stringify(`file://${resolve(root, 'usr/lib/treeseed/manager/node_modules/@treeseed/sdk/dist', module)}`)})`], { encoding: 'utf8' });
	const verifiedCatalog = (path: string) => {
		const catalog = releaseCatalogSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
		const declared = catalog.catalogDigest;
		const material = { ...catalog, catalogDigest: 'sha256:'.padEnd(71, '0') };
		if (deploymentDigest(material) !== declared) throw new Error(`Packaged catalog digest mismatch for ${path}.`);
		return catalog;
	};
	const stable = verifiedCatalog(resolve(root, 'usr/share/treeseed/catalogs/stable.json'));
	if (aptSuite === 'stable' && existsSync(resolve(root, 'usr/share/treeseed/catalogs/development.json'))) throw new Error('Stable package set carries a development catalog.');
	if (aptSuite === 'development') {
		const development = verifiedCatalog(resolve(root, 'usr/share/treeseed/catalogs/development.json'));
		if (development.stableBase?.catalogDigest !== stable.catalogDigest) throw new Error('Development catalog is not bound to the selected stable base.');
	}
	for (const component of selected) {
		const directory = resolve(root, 'usr/share/treeseed/components', component.componentId, component.release);
		const installed = componentReleaseSchema.parse(JSON.parse(readFileSync(resolve(directory, 'component-release.json'), 'utf8')));
		if (installed.runtimeDigest !== component.runtimeDigest) throw new Error(`${component.componentId} installed runtime digest changed.`);
		for (const file of component.runtime.compose.files) if (!existsSync(resolve(directory, file.path))) throw new Error(`${component.componentId} is missing packaged Compose file ${file.path}.`);
	}
} finally { rmSync(root, { recursive: true, force: true }); }
console.log(JSON.stringify({ ok: true, suite: aptSuite, integration: integration.release, packages: files.length, components: selected.map(({ componentId, release, runtimeDigest }) => ({ componentId, release, runtimeDigest })) }));

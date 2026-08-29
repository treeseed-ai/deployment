import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { componentReleaseSchema, integrationReleaseSchema, releaseCatalogSchema } from '@treeseed/sdk/deployment';

const output = resolve('release/out');
const aptSuite = process.env.TREESEED_APT_SUITE;
if (aptSuite !== 'stable' && aptSuite !== 'development') throw new Error('TREESEED_APT_SUITE must be stable or development.');
const integration = integrationReleaseSchema.parse(JSON.parse(readFileSync(resolve('.treeseed/artifacts/integrations', `${aptSuite}.json`), 'utf8')));
const selected = integration.components.map(({ componentId, release }) => componentReleaseSchema.parse(JSON.parse(readFileSync(resolve('.treeseed/artifacts/components', componentId, release, 'component-release.json'), 'utf8'))));
const core = ['treeseed-host-runtime', 'treeseed-manager', 'treeseed-sdk', 'treeseed-cli', 'treeseed-release-catalog', 'treeseed-edge', 'treeseed-kata-runtime'];
if (aptSuite === 'development') core.push('treeseed-release-catalog-development');
const componentPackages = selected.flatMap((component) => component.packages.map((item) => item.name));
const expected = [...new Set([...core, ...componentPackages])];
const files = readdirSync(output).filter((name) => name.endsWith('.deb'));
if (files.length !== expected.length) throw new Error(`Expected exactly ${expected.length} suite artifacts; found ${files.length}.`);

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
	for (const name of ['treeseed-host-runtime', 'treeseed-sdk', 'treeseed-cli', 'treeseed-release-catalog', ...(aptSuite === 'development' ? ['treeseed-release-catalog-development'] : []), ...componentPackages]) execFileSync('dpkg-deb', ['--extract', resolve(output, packageFile(name)), root]);
	execFileSync(resolve(root, 'usr/lib/treeseed/runtime/bin/node'), [resolve(root, 'usr/lib/treeseed/cli/dist/cli/main.js'), 'host', 'status', '--help'], { encoding: 'utf8' });
	const stable = releaseCatalogSchema.parse(JSON.parse(readFileSync(resolve(root, 'usr/share/treeseed/catalogs/stable.json'), 'utf8')));
	if (aptSuite === 'stable' && existsSync(resolve(root, 'usr/share/treeseed/catalogs/development.json'))) throw new Error('Stable package set carries a development catalog.');
	if (aptSuite === 'development') {
		const development = releaseCatalogSchema.parse(JSON.parse(readFileSync(resolve(root, 'usr/share/treeseed/catalogs/development.json'), 'utf8')));
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

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { releaseCatalogSchema } from '@treeseed/sdk/deployment';

const output = resolve('release/out');
const aptSuite = process.env.TREESEED_APT_SUITE;
if (aptSuite !== undefined && aptSuite !== 'stable' && aptSuite !== 'development') throw new Error('TREESEED_APT_SUITE must be stable or development.');
const core = ['treeseed-host-runtime', 'treeseed-manager', 'treeseed-sdk', 'treeseed-cli', 'treeseed-release-catalog', 'treeseed-edge'];
const expected = aptSuite === 'stable' ? [...core, 'treeseed-component-agent'] : [...core, 'treeseed-release-catalog-development', 'treeseed-component-api', 'treeseed-component-agent', 'treeseed-component-treedx', 'treeseed-component-ai', 'treeseed-lab'];
const files = readdirSync(output).filter((name) => name.endsWith('.deb'));
const expectedFileCount = expected.length + (aptSuite === 'stable' ? 0 : 1);
if (files.length !== expectedFileCount) throw new Error(`Expected exactly ${expectedFileCount} suite artifacts; found ${files.length}.`);
for (const name of expected) {
	const matches = files.filter((candidate) => candidate.startsWith(`${name}_`));
	const count = name === 'treeseed-component-agent' && aptSuite !== 'stable' ? 2 : 1;
	if (matches.length !== count) throw new Error(`Expected ${count} Debian artifact(s) for ${name}; found ${matches.length}.`);
	for (const file of matches) {
		const path = resolve(output, file), declared = execFileSync('dpkg-deb', ['--field', path, 'Package'], { encoding: 'utf8' }).trim();
		if (declared !== name) throw new Error(`${file} declares unexpected package ${declared}.`);
		if (name.startsWith('treeseed-component-') || name === 'treeseed-lab') {
			const depends = execFileSync('dpkg-deb', ['--field', path, 'Depends'], { encoding: 'utf8' }).trim();
			if (/treeseed-(?:manager|edge)\s*\(/u.test(depends)) throw new Error(`${file} can force a core package version through ${depends}.`);
		}
		const listing = execFileSync('dpkg-deb', ['--contents', path], { encoding: 'utf8' });
		for (const line of listing.split('\n').filter(Boolean)) {
			const mode = line.slice(0, 10);
			if (mode[5] === 'w' || mode[8] === 'w') throw new Error(`${file} contains a group/world-writable path: ${line}`);
		}
	}
}
const packageVersion = (file: string) => execFileSync('dpkg-deb', ['--field', resolve(output, file), 'Version'], { encoding: 'utf8' }).trim();
const agentVersions = files.filter((file) => file.startsWith('treeseed-component-agent_')).map(packageVersion).sort();
const stableCatalogPackage = files.find((file) => file.startsWith('treeseed-release-catalog_'))!;
if (packageVersion(stableCatalogPackage) !== '0.1.0-1') throw new Error('Stable-base catalog package does not use the stable release identity.');
if (aptSuite === 'stable') {
	if (agentVersions.join(',') !== '0.12.58') throw new Error('Stable Agent Debian version does not match its exact release contract.');
} else {
	const overlayPackage = files.find((file) => file.startsWith('treeseed-release-catalog-development_'))!;
	for (const [field, expectedValue] of [['Depends', 'treeseed-release-catalog (= 0.1.0-1)'], ['Replaces', 'treeseed-release-catalog (<< 0.1.0-1)'], ['Breaks', 'treeseed-release-catalog (<< 0.1.0-1)']] as const) {
		if (execFileSync('dpkg-deb', ['--field', resolve(output, overlayPackage), field], { encoding: 'utf8' }).trim() !== expectedValue) throw new Error(`Development catalog overlay has an invalid ${field} migration contract.`);
	}
	const apiVersion = packageVersion(files.find((file) => file.startsWith('treeseed-component-api_'))!);
	const treeDxVersion = packageVersion(files.find((file) => file.startsWith('treeseed-component-treedx_'))!);
	if (agentVersions.join(',') !== '0.12.58,0.13.0~rc13' || apiVersion !== '0.8.0~rc11' || treeDxVersion !== '0.3.0~rc6') throw new Error('Component Debian versions do not match their exact release contracts.');
}

function proveCatalogOwnershipMigration() {
	if (aptSuite !== 'development') return;
	const migration = mkdtempSync(resolve(tmpdir(), 'treeseed-catalog-migration-'));
	try {
		const legacy = resolve(migration, 'legacy'), data = resolve(legacy, 'usr/share/treeseed/catalogs'), admin = resolve(migration, 'root/var/lib/dpkg');
		mkdirSync(resolve(legacy, 'DEBIAN'), { recursive: true });
		mkdirSync(data, { recursive: true });
		mkdirSync(admin, { recursive: true });
		writeFileSync(resolve(admin, 'status'), '');
		writeFileSync(resolve(legacy, 'DEBIAN/control'), 'Package: treeseed-release-catalog\nVersion: 0.1.0~rc20-1\nArchitecture: all\nMaintainer: TreeSeed Releases <releases@treeseed.ai>\nDescription: Legacy combined catalog fixture\n');
		for (const track of ['stable', 'development']) copyFileSync(resolve('.treeseed/artifacts/catalogs', `${track}.json`), resolve(data, `${track}.json`));
		const legacyDeb = resolve(migration, 'treeseed-release-catalog_0.1.0~rc20-1_all.deb');
		execFileSync('dpkg-deb', ['--build', '--root-owner-group', legacy, legacyDeb]);
		const root = resolve(migration, 'root'), dpkg = (...packages: string[]) => execFileSync('dpkg', ['--force-not-root', `--root=${root}`, `--admindir=${admin}`, `--log=${resolve(root, 'dpkg.log')}`, '--install', ...packages]);
		dpkg(legacyDeb);
		const stablePackage = files.find((file) => file.startsWith('treeseed-release-catalog_'))!, overlayPackage = files.find((file) => file.startsWith('treeseed-release-catalog-development_'))!;
		dpkg(resolve(output, stablePackage), resolve(output, overlayPackage));
		dpkg(resolve(output, stablePackage));
		for (const track of ['stable', 'development']) if (!existsSync(resolve(root, 'usr/share/treeseed/catalogs', `${track}.json`))) throw new Error(`${track} catalog was removed during the split-package migration proof.`);
		const ownership = execFileSync('dpkg-query', [`--admindir=${admin}`, '-S', '/usr/share/treeseed/catalogs/stable.json', '/usr/share/treeseed/catalogs/development.json'], { encoding: 'utf8' });
		if (!ownership.includes('treeseed-release-catalog: /usr/share/treeseed/catalogs/stable.json') || !ownership.includes('treeseed-release-catalog-development: /usr/share/treeseed/catalogs/development.json')) throw new Error('Catalog files do not have independent Debian ownership.');
	} finally { rmSync(migration, { recursive: true, force: true }); }
}
proveCatalogOwnershipMigration();
const root = mkdtempSync(resolve(tmpdir(), 'treeseed-deb-proof-'));
try {
	const proofPackages = aptSuite === 'stable' ? ['treeseed-host-runtime', 'treeseed-sdk', 'treeseed-cli', 'treeseed-release-catalog', 'treeseed-component-agent'] : ['treeseed-host-runtime', 'treeseed-sdk', 'treeseed-cli', 'treeseed-release-catalog', 'treeseed-release-catalog-development', 'treeseed-component-agent', 'treeseed-component-api', 'treeseed-component-treedx', 'treeseed-lab'];
	for (const name of proofPackages) {
		const file = files.find((candidate) => candidate.startsWith(`${name}_`) && (name !== 'treeseed-component-agent' || packageVersion(candidate) === (aptSuite === 'stable' ? '0.12.58' : '0.13.0~rc13')))!;
		execFileSync('dpkg-deb', ['--extract', resolve(output, file), root]);
	}
	execFileSync(resolve(root, 'usr/lib/treeseed/runtime/bin/node'), [resolve(root, 'usr/lib/treeseed/cli/dist/cli/main.js'), 'host', 'status', '--help'], { encoding: 'utf8' });
	const stable = releaseCatalogSchema.parse(JSON.parse(readFileSync(resolve(root, 'usr/share/treeseed/catalogs/stable.json'), 'utf8')));
	if (stable.components[0]?.release !== '0.12.58') throw new Error('Installed stable catalog does not contain the exact stable base.');
	if (aptSuite === 'stable') {
		if (readdirSync(resolve(root, 'usr/share/treeseed/catalogs')).includes('development.json')) throw new Error('Stable catalog package must not carry a development overlay.');
	} else {
		const development = releaseCatalogSchema.parse(JSON.parse(readFileSync(resolve(root, 'usr/share/treeseed/catalogs/development.json'), 'utf8')));
		if (development.stableBase?.catalogDigest !== stable.catalogDigest) throw new Error('Installed development catalog is not bound to the exact stable base.');
		for (const [id, release] of [['agent', '0.13.0~rc13'], ['api', '0.8.0~rc11'], ['treedx', '0.3.0~rc6'], ['lab', '0.1.0~rc21-1']] as const) {
			const directory = resolve(root, 'usr/share/treeseed/components', id, release);
			const component = JSON.parse(readFileSync(resolve(directory, 'component-release.json'), 'utf8')) as { componentId?: string; release?: string };
			const compose = readFileSync(resolve(directory, 'compose.yml'), 'utf8');
			if (component.componentId !== id || component.release !== release || /^\s*(?:build|ports):/mu.test(compose)) throw new Error(`Installed ${id} bundle is not production-safe.`);
		}
	}
} finally { rmSync(root, { recursive: true, force: true }); }
console.log(JSON.stringify({ ok: true, packages: files.length }));

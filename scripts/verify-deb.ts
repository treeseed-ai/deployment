import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { releaseCatalogSchema } from '@treeseed/sdk/deployment';

const output = resolve('release/out');
const expected = ['treeseed-host-runtime', 'treeseed-manager', 'treeseed-sdk', 'treeseed-cli', 'treeseed-release-catalog', 'treeseed-edge', 'treeseed-component-api', 'treeseed-component-agent', 'treeseed-component-treedx', 'treeseed-component-ai', 'treeseed-lab'];
const files = readdirSync(output).filter((name) => name.endsWith('.deb'));
for (const name of expected) {
	const matches = files.filter((candidate) => candidate.startsWith(`${name}_`));
	const count = name === 'treeseed-component-agent' ? 2 : 1;
	if (matches.length !== count) throw new Error(`Expected ${count} Debian artifact(s) for ${name}; found ${matches.length}.`);
	for (const file of matches) {
		const path = resolve(output, file), declared = execFileSync('dpkg-deb', ['--field', path, 'Package'], { encoding: 'utf8' }).trim();
		if (declared !== name) throw new Error(`${file} declares unexpected package ${declared}.`);
		const listing = execFileSync('dpkg-deb', ['--contents', path], { encoding: 'utf8' });
		for (const line of listing.split('\n').filter(Boolean)) {
			const mode = line.slice(0, 10);
			if (mode[5] === 'w' || mode[8] === 'w') throw new Error(`${file} contains a group/world-writable path: ${line}`);
		}
	}
}
const packageVersion = (file: string) => execFileSync('dpkg-deb', ['--field', resolve(output, file), 'Version'], { encoding: 'utf8' }).trim();
const agentVersions = files.filter((file) => file.startsWith('treeseed-component-agent_')).map(packageVersion).sort();
const apiVersion = packageVersion(files.find((file) => file.startsWith('treeseed-component-api_'))!);
const treeDxVersion = packageVersion(files.find((file) => file.startsWith('treeseed-component-treedx_'))!);
if (agentVersions.join(',') !== '0.12.58,0.13.0~rc13' || apiVersion !== '0.8.0~rc9' || treeDxVersion !== '0.3.0~rc5') throw new Error('Component Debian versions do not match their exact release contracts.');
const root = mkdtempSync(resolve(tmpdir(), 'treeseed-deb-proof-'));
try {
	for (const name of ['treeseed-host-runtime', 'treeseed-sdk', 'treeseed-cli', 'treeseed-release-catalog', 'treeseed-component-agent', 'treeseed-component-api', 'treeseed-component-treedx', 'treeseed-lab']) {
		const file = files.find((candidate) => candidate.startsWith(`${name}_`) && (name !== 'treeseed-component-agent' || packageVersion(candidate) === '0.13.0~rc13'))!;
		execFileSync('dpkg-deb', ['--extract', resolve(output, file), root]);
	}
	execFileSync(resolve(root, 'usr/lib/treeseed/runtime/bin/node'), [resolve(root, 'usr/lib/treeseed/cli/dist/cli/main.js'), 'host', 'status', '--help'], { encoding: 'utf8' });
	const stable = releaseCatalogSchema.parse(JSON.parse(readFileSync(resolve(root, 'usr/share/treeseed/catalogs/stable.json'), 'utf8')));
	const development = releaseCatalogSchema.parse(JSON.parse(readFileSync(resolve(root, 'usr/share/treeseed/catalogs/development.json'), 'utf8')));
	if (development.stableBase?.catalogDigest !== stable.catalogDigest || stable.components[0]?.release !== '0.12.58') throw new Error('Installed catalogs are not bound to the exact stable base.');
	for (const [id, release] of [['agent', '0.13.0~rc13'], ['api', '0.8.0~rc9'], ['treedx', '0.3.0~rc5'], ['lab', '0.1.0~rc2-1']] as const) {
		const directory = resolve(root, 'usr/share/treeseed/components', id, release);
		const component = JSON.parse(readFileSync(resolve(directory, 'component-release.json'), 'utf8')) as { componentId?: string; release?: string };
		const compose = readFileSync(resolve(directory, 'compose.yml'), 'utf8');
		if (component.componentId !== id || component.release !== release || /^\s*(?:build|ports):/mu.test(compose)) throw new Error(`Installed ${id} bundle is not production-safe.`);
	}
} finally { rmSync(root, { recursive: true, force: true }); }
console.log(JSON.stringify({ ok: true, packages: files.length }));

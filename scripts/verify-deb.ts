import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const output = resolve('release/out');
const expected = ['treeseed-host-runtime', 'treeseed-manager', 'treeseed-sdk', 'treeseed-cli', 'treeseed-release-catalog', 'treeseed-edge', 'treeseed-component-api', 'treeseed-component-agent', 'treeseed-component-treedx', 'treeseed-component-ai', 'treeseed-lab'];
const files = readdirSync(output).filter((name) => name.endsWith('.deb'));
for (const name of expected) {
	const matches = files.filter((candidate) => candidate.startsWith(`${name}_`));
	if (matches.length !== 1) throw new Error(`Expected exactly one Debian artifact for ${name}; found ${matches.length}.`);
	const file = matches[0]!;
	if (!file) throw new Error(`Missing Debian artifact ${name}.`);
	const path = resolve(output, file), declared = execFileSync('dpkg-deb', ['--field', path, 'Package'], { encoding: 'utf8' }).trim();
	if (declared !== name) throw new Error(`${file} declares unexpected package ${declared}.`);
	const listing = execFileSync('dpkg-deb', ['--contents', path], { encoding: 'utf8' });
	for (const line of listing.split('\n').filter(Boolean)) {
		const mode = line.slice(0, 10);
		if (mode[5] === 'w' || mode[8] === 'w') throw new Error(`${file} contains a group/world-writable path: ${line}`);
	}
}
const versions = Object.fromEntries(expected.map((name) => {
	const file = files.find((candidate) => candidate.startsWith(`${name}_`))!;
	return [name, execFileSync('dpkg-deb', ['--field', resolve(output, file), 'Version'], { encoding: 'utf8' }).trim()];
}));
if (versions['treeseed-component-agent'] !== '0.13.0~rc11' || versions['treeseed-component-api'] !== '0.8.0~rc9') throw new Error('Component Debian versions do not match their exact release contracts.');
const root = mkdtempSync(resolve(tmpdir(), 'treeseed-deb-proof-'));
try {
	for (const name of ['treeseed-host-runtime', 'treeseed-sdk', 'treeseed-cli', 'treeseed-component-agent', 'treeseed-component-api']) {
		const file = files.find((candidate) => candidate.startsWith(`${name}_`))!;
		execFileSync('dpkg-deb', ['--extract', resolve(output, file), root]);
	}
	execFileSync(resolve(root, 'usr/lib/treeseed/runtime/bin/node'), [resolve(root, 'usr/lib/treeseed/cli/dist/cli/main.js'), 'host', 'status', '--help'], { encoding: 'utf8' });
	for (const [id, release] of [['agent', '0.13.0~rc11'], ['api', '0.8.0~rc9']] as const) {
		const directory = resolve(root, 'usr/share/treeseed/components', id, release);
		const component = JSON.parse(readFileSync(resolve(directory, 'component-release.json'), 'utf8')) as { componentId?: string; release?: string };
		const compose = readFileSync(resolve(directory, 'compose.yml'), 'utf8');
		if (component.componentId !== id || component.release !== release || /^\s*(?:build|ports):/mu.test(compose)) throw new Error(`Installed ${id} bundle is not production-safe.`);
	}
} finally { rmSync(root, { recursive: true, force: true }); }
console.log(JSON.stringify({ ok: true, packages: expected.length }));

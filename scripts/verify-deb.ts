import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const output = resolve('release/out');
const expected = ['treeseed-host-runtime', 'treeseed-manager', 'treeseed-sdk', 'treeseed-cli', 'treeseed-release-catalog', 'treeseed-edge', 'treeseed-component-api', 'treeseed-component-agent', 'treeseed-component-treedx', 'treeseed-component-ai', 'treeseed-lab'];
const files = readdirSync(output).filter((name) => name.endsWith('.deb'));
for (const name of expected) {
	const file = files.find((candidate) => candidate.startsWith(`${name}_`));
	if (!file) throw new Error(`Missing Debian artifact ${name}.`);
	const path = resolve(output, file), declared = execFileSync('dpkg-deb', ['--field', path, 'Package'], { encoding: 'utf8' }).trim();
	if (declared !== name) throw new Error(`${file} declares unexpected package ${declared}.`);
	const listing = execFileSync('dpkg-deb', ['--contents', path], { encoding: 'utf8' });
	for (const line of listing.split('\n').filter(Boolean)) {
		const mode = line.slice(0, 10);
		if (mode[5] === 'w' || mode[8] === 'w') throw new Error(`${file} contains a group/world-writable path: ${line}`);
	}
}
console.log(JSON.stringify({ ok: true, packages: expected.length }));

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const roots = ['src', 'scripts', 'tests'];
const files: string[] = [];
function walk(path: string) {
	for (const name of readdirSync(path)) {
		const child = resolve(path, name), stat = statSync(child);
		if (stat.isDirectory()) walk(child); else if (/\.(?:ts|js)$/u.test(name)) files.push(child);
	}
}
for (const root of roots) walk(resolve(root));
const oversized = files.map((file) => ({ file, lines: readFileSync(file, 'utf8').split('\n').length })).filter((entry) => entry.lines > 500);
if (oversized.length) throw new Error(`Source files exceed 500 lines: ${oversized.map((entry) => `${entry.file} (${entry.lines})`).join(', ')}`);
console.log(`Source-shape check passed for ${files.length} files.`);

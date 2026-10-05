import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it('imports the built archive reader without node_modules or the source checkout', () => {
	const root = mkdtempSync(resolve(tmpdir(), 'treeseed-backup-runtime-'));
	const target = resolve(root, 'backup-stream.mjs');
	copyFileSync(resolve('dist/src/supervisor/backup-stream.js'), target);
	const output = execFileSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(pathToFileURL(target).href)});console.log(typeof m.inspectBackupStream);`], { cwd:root,encoding:'utf8' });
	expect(output.trim()).toBe('function');
});

import { spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const marker = resolve('dist/.treeseed-build-complete.json');
const temporary = `${marker}.new`;
rmSync(marker, { force: true });
const result = spawnSync('npm', ['run', 'build'], {
	cwd: process.cwd(),
	env: process.env,
	stdio: 'inherit',
});
if (result.status !== 0) process.exitCode = result.status ?? 1;
else {
	mkdirSync(dirname(marker), { recursive: true });
	writeFileSync(temporary, `${JSON.stringify({ completedAt: new Date().toISOString() })}\n`);
	renameSync(temporary, marker);
}

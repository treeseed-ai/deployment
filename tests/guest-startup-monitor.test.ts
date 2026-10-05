import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

for (const [mode, expected] of [
	['success', null], ['missing-import', 'ERR_MODULE_NOT_FOUND'],
	['secret-error', 'UNCLASSIFIED'], ['early-exit', 'EXIT_1'],
	['application-failure', 'application-owned failure'],
] as const) {
	it(`records bounded startup metadata for ${mode} without changing its exit`, () => {
		const root = mkdtempSync(resolve(tmpdir(), 'guest-monitor-'));
		try {
			const child = spawnSync(process.execPath, ['--import', 'tsx', 'tests/fixtures/guest-startup-monitor-worker.ts', root, mode],
				{ encoding: 'utf8', timeout: 10_000 });
			expect(child.status).toBe(mode === 'success' ? 0 : 1);
			const failure = resolve(root, 'failure.json');
			if (expected === null) expect(existsSync(failure)).toBe(false);
			else {
				const source = readFileSync(failure, 'utf8');
				expect(source).toContain(expected);
				expect(source).not.toContain('do-not-export-test-credential');
				expect(source).not.toContain('missing-guest-dependency');
				expect(source.length).toBeLessThan(512);
			}
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
}

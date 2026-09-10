import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSourceWorkspace } from '../src/sandbox/workspace-builder-guest.js';

describe('source-only guest workspace builder', () => {
	it('constructs exact Git source, preserves history across incremental bundles and rejects dirty parents', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'treeseed-source-builder-'));
		const source = join(directory, 'source'), target = join(directory, 'workspace'), bundle = join(directory, 'source.bundle');
		mkdirSync(source);
		const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', source, ...args], { encoding: 'utf8',
			env: { PATH: '/usr/bin:/bin', HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
				GIT_AUTHOR_NAME: 'Workspace Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
				GIT_COMMITTER_NAME: 'Workspace Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
		try {
			git('init', '--quiet', '--initial-branch=treeseed-source');
			writeFileSync(join(source, 'code.ts'), 'export const revision = 1;\n'); git('add', 'code.ts'); git('commit', '--quiet', '-m', 'fixture source');
			const first = git('rev-parse', 'HEAD'); git('bundle', 'create', bundle, 'refs/heads/treeseed-source');
			expect((await buildSourceWorkspace({ root: target, bundle, commit: first, parentCommit: null })).clean).toBe(true);
			expect(readFileSync(join(target, 'code.ts'), 'utf8')).toContain('revision = 1');
			writeFileSync(join(source, 'code.ts'), 'export const revision = 2;\n'); git('commit', '--quiet', '-am', 'fixture update');
			const second = git('rev-parse', 'HEAD'); git('bundle', 'create', bundle, 'refs/heads/treeseed-source', `^${first}`);
			expect((await buildSourceWorkspace({ root: target, bundle, commit: second, parentCommit: first })).commit).toBe(second);
			expect(execFileSync('/usr/bin/git', ['-C', target, 'rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim()).toBe(first);
			writeFileSync(join(target, 'unexpected.txt'), 'unpublished work');
			await expect(buildSourceWorkspace({ root: target, bundle, commit: second, parentCommit: second })).rejects.toThrow('not clean');
		} finally { rmSync(directory, { recursive: true, force: true }); }
	});
});

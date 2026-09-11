import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifySourceCandidate } from '../src/sandbox/workspace-candidate-guest.js';
import { buildSourceWorkspace } from '../src/sandbox/workspace-builder-guest.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'treeseed-candidate-test-')), root = join(directory, 'project'); mkdirSync(root);
  const git = (args: string[]) => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } }).trim();
  git(['init', '--quiet']); writeFileSync(join(root, 'code.ts'), 'export const value = 1;\n'); git(['add', '.']); git(['commit', '--quiet', '-m', 'base']);
  const baseCommit = git(['rev-parse', 'HEAD']); writeFileSync(join(root, 'code.ts'), 'export const value = 2;\n'); git(['add', '.']); git(['commit', '--quiet', '-m', 'candidate']);
  const commit = git(['rev-parse', 'HEAD']);
  return { directory, root, git, input: { root, baseCommit, commit, output: join(directory, 'source.bundle'), maxBytes: 1_048_576, scratch: join(directory, 'scratch') }, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
describe('independent source candidate verifier', () => {
  it('verifies ancestry, committed work and a portable history bundle', async () => {
    const f = fixture(); try {
      const result = await verifySourceCandidate(f.input); expect(result).toMatchObject({ commit: f.input.commit, baseCommit: f.input.baseCommit, objectClosure: true, ancestry: true, clean: true });
      expect(f.git(['bundle', 'list-heads', f.input.output])).toBe(`${f.input.commit} refs/heads/treeseed-source`);
      const rebuilt = await buildSourceWorkspace({ root: join(f.directory, 'review'), bundle: f.input.output, commit: f.input.commit, parentCommit: null });
      expect(rebuilt).toMatchObject({ commit: f.input.commit, clean: true, objectClosure: true });
    } finally { f.cleanup(); }
  });
  it('never executes guest repository configuration during verification', async () => {
    const f = fixture(); try {
      const marker = join(f.directory, 'executed');
      f.git(['config', 'core.fsmonitor', `touch ${marker}`]);
      f.git(['config', 'core.hooksPath', f.directory]);
      f.git(['config', 'filter.evil.clean', `touch ${marker}`]);
      await verifySourceCandidate(f.input); expect(existsSync(marker)).toBe(false);
    } finally { f.cleanup(); }
  });
  it('rejects uncommitted tracked and untracked work instead of silently losing it', async () => {
    const f = fixture(); try {
      writeFileSync(join(f.root, 'code.ts'), 'uncommitted');
      await expect(verifySourceCandidate(f.input)).rejects.toThrow('uncommitted');
      writeFileSync(join(f.root, 'code.ts'), 'export const value = 2;\n'); writeFileSync(join(f.root, 'new.ts'), 'untracked');
      await expect(verifySourceCandidate(f.input)).rejects.toThrow('uncommitted');
    } finally { f.cleanup(); }
  });
  it('rejects alternate object stores and output overflow', async () => {
    const f = fixture(); try {
      await expect(verifySourceCandidate({ ...f.input, maxBytes: 1 })).rejects.toThrow('output limit');
      writeFileSync(join(f.root, '.git/objects/info/alternates'), '/elsewhere\n');
      await expect(verifySourceCandidate(f.input)).rejects.toThrow('alternates');
    } finally { f.cleanup(); }
  });
  it('rejects a candidate that is not descended from its authorized base', async () => {
    const f = fixture(); try {
      await expect(verifySourceCandidate({ ...f.input, baseCommit: f.input.commit, commit: f.input.baseCommit })).rejects.toThrow();
    } finally { f.cleanup(); }
  });
});

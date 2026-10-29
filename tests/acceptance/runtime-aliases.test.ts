import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
class RuntimeAliasAcceptance {
  static small(): void {
    const result = spawnSync('node', ['dist/tests/support/runtime-alias-program.js'], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'runtime-aliases-public-ok\n');
  }
  static upstream(): void {
    const result = spawnSync('node', ['dist/tests/support/runtime-alias-program.js', '--actual',
      join(process.env.RUNNER_TEMP ?? '/missing', 'kata.tar.zst')], { encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'runtime-aliases-upstream-ok\n');
  }
  static foreign(): void {
    const result = spawnSync('sudo', ['-n', 'env', 'GITHUB_ACTIONS=' + process.env.GITHUB_ACTIONS,
      'RUNNER_ENVIRONMENT=' + process.env.RUNNER_ENVIRONMENT, process.execPath,
      resolve('dist/tests/support/runtime-alias-program.js'), '--foreign'], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'runtime-aliases-foreign-owner-ok\n');
  }
}
test('acceptance: built public runtime alias custody binds inert installed links without effects', RuntimeAliasAcceptance.small);
test('acceptance: pinned upstream runtime aliases match retained installed members without execution', RuntimeAliasAcceptance.upstream, 125000);
test('acceptance: hosted runtime alias custody rejects a genuinely foreign-owned link', RuntimeAliasAcceptance.foreign, 20000);

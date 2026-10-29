import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'bun:test';
class InstalledComponentProgramAcceptance {
  run(): void {
    const result = spawnSync('node', ['dist/tests/support/runtime-components-program.js'], {
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'runtime-components-public-ok\n');
  }
}
const suite = new InstalledComponentProgramAcceptance();
test(
  'acceptance: built public installed component custody binds exact kit bytes without effects',
  suite.run.bind(suite),
  20000,
);

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
class RuntimeArchiveAcceptance {
  publicProgram(): void {
    const result = spawnSync('node', ['dist/tests/support/runtime-archive-program.js'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'runtime-archive-custody-ok\n');
  }
}
const suite = new RuntimeArchiveAcceptance();
test(
  'acceptance: built public runtime archive custody retains verified bytes and refuses changed file identity',
  suite.publicProgram.bind(suite),
);

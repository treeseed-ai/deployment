import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
class GuestRuntimeAcceptance {
  run(): void {
    const result = spawnSync('bun', ['dist/tests/support/guest-runtime-program.js'], {
      encoding: 'utf8',
      timeout: 120000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'guest-artifact-ok\n');
  }
}
const suite = new GuestRuntimeAcceptance();
test(
  'acceptance: built public guest runtime admission verifies genuine archives without host execution',
  suite.run.bind(suite),
  130000,
);

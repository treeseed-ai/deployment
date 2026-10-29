import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'bun:test';
class CooperativePackageAcceptance {
  run(): void {
    const result = spawnSync('node', ['dist/tests/support/cooperative-package-program.js'], {
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'cooperative-package-public-ok\n');
  }
}
const suite = new CooperativePackageAcceptance();
test(
  'acceptance: built public package materialization yields during verified private publication',
  suite.run.bind(suite),
  20000,
);

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'bun:test';
class ParallelPackageAcceptance {
  run(): void {
    const result = spawnSync('node', ['dist/tests/support/parallel-package-program.js'], {
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'parallel-package-public-ok\n');
  }
}
const suite = new ParallelPackageAcceptance();
test(
  'acceptance: built public package materialization overlaps at most eight durable member publications',
  suite.run.bind(suite),
  35000,
);

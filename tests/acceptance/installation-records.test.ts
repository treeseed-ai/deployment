import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'bun:test';
class InstallationRecordsAcceptance {
  run(): void {
    const result = spawnSync('node', ['dist/tests/support/installation-records-program.js'], {
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'installation-records-public-ok\n');
  }
}
const suite = new InstallationRecordsAcceptance();
test(
  'acceptance: built public installation records persist private scoped read-back without source bundles or activation',
  suite.run.bind(suite),
  35000,
);

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
class DockerEvidenceAcceptance {
  run(): void {
    const result = spawnSync('node', ['dist/tests/support/docker-evidence-program.js'], {
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'docker-command-evidence-ok\n');
  }
}
const suite = new DockerEvidenceAcceptance();
test(
  'acceptance: built public Docker adapter retains safe exact failure evidence and clears it after success',
  suite.run.bind(suite),
  20000,
);

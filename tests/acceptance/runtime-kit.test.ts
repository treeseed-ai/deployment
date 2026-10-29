import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { spawnSync } from 'node:child_process';
class RuntimeKitAcceptance {
  configuration(): void {
    const result = spawnSync('node', ['dist/tests/support/runtime-kit-program.js'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'kata-runtime-kit-interface-ok\n');
  }
}
const suite = new RuntimeKitAcceptance();
test(
  'acceptance: built native Kata configuration admits exact optional runtime kit custody before host effects',
  suite.configuration.bind(suite),
);

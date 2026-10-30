import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'bun:test';

class NativePolicyAcceptance {
  interface(): void {
    const result = spawnSync('node', ['dist/tests/support/native-policy-program.js'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'native-policy-interface-ok\n');
    assert.equal(result.stderr, '');
  }
}
const suite = new NativePolicyAcceptance();
test(
  'acceptance: built native host policy selection rejects incomplete custody before effects',
  suite.interface.bind(suite),
);

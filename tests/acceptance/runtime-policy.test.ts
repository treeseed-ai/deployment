import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'bun:test';
class EffectiveRuntimePolicyAcceptance {
  static program(): void {
    const result = spawnSync('node', ['dist/tests/support/runtime-policy-program.js'], {
      encoding: 'utf8',
      timeout: 300000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'effective-runtime-policy-public-ok\n');
  }
}
test(
  'acceptance: built public effective runtime policy binds genuine prepared kit and bounded configuration without activation',
  EffectiveRuntimePolicyAcceptance.program,
  305000,
);

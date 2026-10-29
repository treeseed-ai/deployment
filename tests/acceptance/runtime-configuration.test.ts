import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { spawnSync } from 'node:child_process';
class RuntimeConfigurationAcceptance {
  run(): void {
    const result = spawnSync('node', ['dist/tests/support/runtime-configuration-program.js'], {
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'runtime-configuration-public-ok\n');
  }
}
const suite = new RuntimeConfigurationAcceptance();
test(
  'acceptance: built public runtime configuration reader binds strict TOML references without execution',
  suite.run.bind(suite),
  20000,
);

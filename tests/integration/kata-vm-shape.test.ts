import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { spawnSync } from 'node:child_process';
class VmStartupBoundaries {
  program(mode: string): void {
    const result = spawnSync('node', ['dist/tests/support/kata-vm-shape-program.js', mode], {
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'vm-startup-' + mode + '-ok\n');
  }
}
const suite = new VmStartupBoundaries();
for (const mode of [
  'normal',
  'missing',
  'duplicate',
  'malformed',
  'overflow',
  'identity',
  'generation',
])
  test(
    'integration: default Linux VM startup observer preserves process and argument binding for ' +
      mode,
    suite.program.bind(suite, mode),
    20000,
  );

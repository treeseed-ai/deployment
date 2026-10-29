import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'bun:test';
import { join } from 'node:path';
class InstalledComponentProgramAcceptance {
  actual(): void {
    const result = spawnSync(
      'node',
      [
        'dist/tests/support/runtime-components-program.js',
        'actual',
        join(process.env.RUNNER_TEMP ?? '/missing', 'kata.tar.zst'),
      ],
      {
        encoding: 'utf8',
        timeout: 120000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'runtime-components-upstream-ok\n');
  }
  run(): void {
    const result = spawnSync('node', ['dist/tests/support/runtime-components-program.js'], {
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'runtime-components-public-ok\n');
  }
}
const suite = new InstalledComponentProgramAcceptance();
test(
  'acceptance: built public installed component custody binds exact kit bytes without effects',
  suite.run.bind(suite),
  20000,
);
test(
  'acceptance: pinned upstream kit binds six installed runtime components without execution',
  suite.actual.bind(suite),
  125000,
);

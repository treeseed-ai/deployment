import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
class RuntimeKitMemberAcceptance {
  program(mode: string): void {
    const result = spawnSync(
      'node',
      [
        'dist/tests/support/runtime-kit-members-program.js',
        mode,
        join(process.env.RUNNER_TEMP ?? '/missing', 'kata.tar.zst'),
      ],
      {
        encoding: 'utf8',
        timeout: mode === 'actual' ? 120000 : 10000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'runtime-kit-members-ok\n');
  }
}
const suite = new RuntimeKitMemberAcceptance();
test(
  'acceptance: built public runtime kit inspection binds exact selected members and in-archive links without extraction',
  suite.program.bind(suite, 'valid'),
);
test(
  'acceptance: built public runtime kit inspector rejects trailing compressed-stream bytes without exposing them',
  suite.program.bind(suite, 'garbage'),
);

test(
  'acceptance: pinned upstream Kata kit yields exact binary kernel rootfs and configuration members without execution',
  suite.program.bind(suite, 'actual'),
  125000,
);

for (const mode of ['long-path', 'long-link'])
  test(
    'acceptance: built public kit inspection preserves bounded GNU control ' + mode,
    suite.program.bind(suite, mode),
  );

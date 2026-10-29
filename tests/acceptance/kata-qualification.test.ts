import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
class KataQualificationAcceptance {
  unqualified(): void {
    const result = spawnSync('node', ['dist/tests/support/kata-qualification-program.js'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'kata-public-fixture-unqualified-ok\n');
  }
}
const suite = new KataQualificationAcceptance();
test(
  'acceptance: built public Kata fixture refuses unqualified construction before daemon state',
  suite.unqualified.bind(suite),
);

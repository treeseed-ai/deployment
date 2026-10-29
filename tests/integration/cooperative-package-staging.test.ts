import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { test } from 'bun:test';
import { CooperativePackageFixture } from '../support/cooperative-package-program.js';
class CooperativePackageBoundaries {
  async densePrefix(): Promise<void> {
    const fixture = new CooperativePackageFixture('dense-prefix');
    try {
      await fixture.materialize();
      fixture.verify();
    } finally {
      fixture.close();
    }
  }
  async readable(): Promise<void> {
    const fixture = new CooperativePackageFixture();
    try {
      await fixture.materialize(false);
      fixture.verify(false);
    } finally {
      fixture.close();
    }
  }
  async rejected(mode: string): Promise<void> {
    const fixture = new CooperativePackageFixture(mode);
    try {
      await assert.rejects(fixture.materialize.bind(fixture));
      const terminal = readdirSync(fixture.target);
      for (let turn = 0; turn < 4; turn++)
        await new Promise<void>(CooperativePackageBoundaries.turn);
      assert.deepEqual(readdirSync(fixture.target), terminal);
      assert.equal(existsSync(fixture.canary), false);
      assert.equal(existsSync(fixture.root + '/escape'), false);
    } finally {
      fixture.close();
    }
  }
  private static turn(done: (value: void) => void): void {
    setImmediate(done);
  }
}
const suite = new CooperativePackageBoundaries();
test(
  'integration: cooperative input preserves the original whole-archive expansion bound for dense prefixes',
  suite.densePrefix.bind(suite),
  15000,
);
test(
  'integration: readable public package materialization preserves exact bytes modes and fairness',
  suite.readable.bind(suite),
  15000,
);
for (const mode of ['tamper', 'duplicate', 'link', 'traversal'])
  test(
    'integration: cooperative package publication rejects ' + mode + ' without script execution',
    suite.rejected.bind(suite, mode),
    15000,
  );

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'bun:test';
import { CooperativePackageFixture } from '../support/cooperative-package-program.js';
class CooperativePackageBoundaries {
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
      assert.equal(existsSync(fixture.canary), false);
      assert.equal(existsSync(fixture.root + '/escape'), false);
    } finally {
      fixture.close();
    }
  }
}
const suite = new CooperativePackageBoundaries();
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

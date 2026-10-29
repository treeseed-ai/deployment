import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { BootArguments, BootProcessFixture } from '../support/kata-boot-program.js';
class BootObservationBoundaries {
  async stale(mode: string): Promise<void> {
    const fixture = new BootProcessFixture();
    try {
      await fixture.prepare();
      const identity = { ...fixture.identity! };
      if (mode === 'start') identity.startTime = '0';
      if (mode === 'command') identity.commandDigest = '0'.repeat(64);
      if (mode === 'executable') identity.executableDigest = '0'.repeat(64);
      if (mode === 'ended') await fixture.close();
      assert.throws(fixture.read.bind(fixture, identity), this.safe);
    } finally {
      await fixture.close();
    }
  }
  private safe(error: unknown): boolean {
    assert(error instanceof Error);
    assert.equal(error.message, 'SANDBOX_BOOT_OBSERVATION_UNVERIFIED');
    assert(!String(error).includes('PRIVATE_'));
    assert.equal(Reflect.get(error, 'cause'), undefined);
    return true;
  }
  async malformed(): Promise<void> {
    const fixture = new BootProcessFixture();
    try {
      await fixture.prepare([...BootArguments.fixture(), '-kernel', '/PRIVATE_OTHER_KERNEL']);
      assert.throws(fixture.read.bind(fixture), this.safe);
    } finally {
      await fixture.close();
    }
  }
}
const suite = new BootObservationBoundaries();
for (const mode of ['start', 'command', 'executable', 'ended'])
  test(
    'integration: real process boot observation rejects ' + mode + ' identity',
    suite.stale.bind(suite, mode),
    15000,
  );
test(
  'integration: real process boot observation rejects ambiguous command without private output',
  suite.malformed.bind(suite),
  15000,
);

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'bun:test';
import { ParallelPackageFixture } from '../support/parallel-package-program.js';
class ParallelPublicationBoundaries {
  async conflict(mode: 'conflict' | 'symlink'): Promise<void> {
    const fixture = new ParallelPackageFixture();
    fixture.mutation = mode;
    try {
      await assert.rejects(fixture.run.bind(fixture), {
        message: 'Verified package staging failed',
      });
      this.preservedMember(fixture, mode);
      assert.equal(
        readdirSync(fixture.target).some(ParallelPublicationBoundaries.temporary),
        false,
      );
      const snapshot = fixture.snapshot();
      await this.turns();
      assert.deepEqual(fixture.snapshot(), snapshot);
    } finally {
      fixture.close();
    }
  }
  private preservedMember(fixture: ParallelPackageFixture, mode: 'conflict' | 'symlink'): void {
    const file = join(fixture.target, 'file-511.txt');
    assert.equal(
      readFileSync(file, 'utf8'),
      mode === 'conflict' ? 'EXISTING_MEMBER_CANARY' : 'OUTSIDE_MEMBER_CANARY',
    );
    assert.equal(lstatSync(file).isSymbolicLink(), mode === 'symlink');
  }
  async descriptors(): Promise<void> {
    await this.readable();
    const before = readdirSync('/proc/self/fd').length;
    for (let count = 0; count < 3; count++) await this.malformed('duplicate');
    await this.turns();
    assert.equal(readdirSync('/proc/self/fd').length, before);
  }
  async readable(): Promise<void> {
    const fixture = new ParallelPackageFixture();
    try {
      await fixture.run(true);
      fixture.verified(true);
    } finally {
      fixture.close();
    }
  }
  async replaced(): Promise<void> {
    const fixture = new ParallelPackageFixture();
    try {
      await assert.rejects(fixture.run.bind(fixture, false, true), {
        message: 'Verified package staging failed',
      });
      assert.equal(fixture.replaced, true);
      assert.deepEqual(readdirSync(fixture.target), ['CANARY']);
      const snapshot = fixture.snapshot(fixture.displaced);
      await this.turns();
      assert.deepEqual(fixture.snapshot(fixture.displaced), snapshot);
      assert.deepEqual(readdirSync(fixture.target), ['CANARY']);
    } finally {
      fixture.close();
    }
  }
  async malformed(mode: string): Promise<void> {
    const fixture = new ParallelPackageFixture(mode);
    try {
      await assert.rejects(fixture.run.bind(fixture), {
        message: 'Verified package staging failed',
      });
      assert.equal(
        readdirSync(fixture.target).some(ParallelPublicationBoundaries.temporary),
        false,
      );
      const snapshot = fixture.snapshot();
      await this.turns();
      assert.deepEqual(fixture.snapshot(), snapshot);
    } finally {
      fixture.close();
    }
  }
  private static temporary(name: string): boolean {
    return name.startsWith('.tmp-');
  }
  private async turns(): Promise<void> {
    for (let index = 0; index < 8; index++)
      await new Promise<void>(ParallelPublicationBoundaries.turn);
  }
  private static turn(done: (value: void) => void): void {
    setImmediate(done);
  }
}
const suite = new ParallelPublicationBoundaries();
for (const mode of ['conflict', 'symlink'] as const)
  test(
    'integration: asynchronous publication refuses a raced ' + mode + ' without overwriting it',
    suite.conflict.bind(suite, mode),
    15000,
  );
test(
  'integration: repeated failed archive publication closes all owned descriptors before rejection',
  suite.descriptors.bind(suite),
  15000,
);
test(
  'integration: readable durable publication retains bounded overlap and exact bytes/modes',
  suite.readable.bind(suite),
  15000,
);
test(
  'integration: replaced destination stops queued publications and settles before safe rejection',
  suite.replaced.bind(suite),
  15000,
);
for (const mode of ['duplicate', 'link', 'traversal'])
  test(
    'integration: malformed parallel archive ' +
      mode +
      ' settles every publication before rejection',
    suite.malformed.bind(suite, mode),
    15000,
  );

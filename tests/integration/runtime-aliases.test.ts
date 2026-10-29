import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { appendFileSync, chmodSync, closeSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { CanonicalJson } from '@treeseed-cordis/sdk';
import { AliasFixture } from '../support/runtime-alias-program.js';
class AliasBoundaries {
  async rejected(mode: string): Promise<void> {
    const fixture = new AliasFixture();
    try {
      await fixture.prepare();
      const signal = mode === 'cancelled' ? AbortSignal.abort() : fixture.signal;
      const root = this.invalid(fixture, mode);
      const before = AliasFixture.descriptors();
      await assert.rejects(fixture.open.bind(fixture, signal, root), {
        message: mode === 'cancelled' ? 'KATA_CANCELLED' : 'KATA_RUNTIME_ALIASES_INVALID',
      });
      assert.equal(AliasFixture.descriptors(), before);
      fixture.archive!.verify();
    } finally { fixture.close(); }
  }
  private invalid(fixture: AliasFixture, mode: string): string {
    if (mode === 'relative') return 'PRIVATE_ROOT';
    if (mode === 'noncanonical') return fixture.root + '/.';
    if (mode === 'wrong-root') return fixture.directory;
    if (mode === 'target') fixture.replace();
    if (mode === 'regular') { rmSync(fixture.alias); writeFileSync(fixture.alias, fixture.bytes); }
    if (mode === 'parent-mode') chmodSync(fixture.parent, 0o777);
    if (mode === 'root-mode') chmodSync(fixture.root, 0o1777);
    if (mode === 'ancestor') {
      renameSync(fixture.parent, fixture.parent + '-held');
      symlinkSync(fixture.parent + '-held', fixture.parent);
    }
    if (mode === 'closed-components') fixture.components!.close();
    return fixture.root;
  }
  async changed(mode: string): Promise<void> {
    const fixture = new AliasFixture();
    try {
      await fixture.prepare();
      const custody = await fixture.open();
      this.mutate(fixture, mode);
      assert.throws(custody.verify.bind(custody), { message: 'KATA_RUNTIME_ALIASES_CHANGED' });
      custody.close();
    } finally { fixture.close(); }
  }
  private mutate(fixture: AliasFixture, mode: string): void {
    if (mode === 'same-target') fixture.replace('components/kernel.original');
    if (mode === 'target') fixture.replace();
    if (mode === 'parent') {
      renameSync(fixture.parent, fixture.parent + '-old');
      symlinkSync(fixture.parent + '-old', fixture.parent);
    }
    if (mode === 'parent-mode') chmodSync(fixture.parent, 0o777);
    if (mode === 'root-mode') chmodSync(fixture.root, 0o1777);
    if (mode === 'bytes') appendFileSync(fixture.terminal, 'PRIVATE_BYTES_CANARY');
    if (mode === 'components') fixture.components!.close();
    if (mode === 'archive') fixture.archive!.close();
  }
  async interruption(mode: string): Promise<void> {
    const fixture = new AliasFixture();
    try {
      await fixture.prepare();
      const controller = new AbortController(), before = AliasFixture.descriptors();
      const pending = fixture.open(controller.signal);
      if (mode === 'cancel') controller.abort();
      else fixture.replace('components/kernel.original');
      await assert.rejects(pending, { message: mode === 'cancel' ? 'KATA_CANCELLED' : 'KATA_RUNTIME_ALIASES_INVALID' });
      assert.equal(AliasFixture.descriptors(), before);
      fixture.components!.verify();
    } finally { fixture.close(); }
  }
  async proof(): Promise<void> {
    const fixture = new AliasFixture();
    try {
      await fixture.prepare();
      const custody = await fixture.open(), { digest, ...payload } = custody.proof;
      assert.equal(digest, CanonicalJson.digest(payload));
      assert.deepEqual(payload.bindings, [{ role: 'kernel', member: 'opt/kata/current', path: fixture.terminal }]);
      assert.deepEqual(payload.aliases, [
        { path: fixture.current, target: fixture.alias },
        { path: fixture.alias, target: fixture.terminal },
      ]);
      assert(Object.isFrozen(payload.bindings[0]) && Object.isFrozen(payload.aliases[0]));
      assert.equal(Reflect.set(payload.bindings[0]!, 'path', '/PRIVATE_CHANGE'), false);
    } finally { fixture.close(); }
  }
  async disposal(): Promise<void> {
    const fixture = new AliasFixture();
    try {
      await fixture.prepare();
      const before = AliasFixture.descriptors(), custody = await fixture.open();
      custody.close(); custody.close();
      assert.equal(AliasFixture.descriptors(), before);
      assert.throws(custody.verify.bind(custody), { message: 'KATA_RUNTIME_ALIASES_CLOSED' });
      fixture.components!.verify();
      fixture.archive!.verify();
    } finally { fixture.close(); }
  }
  async failedClose(): Promise<void> {
    const fixture = new AliasFixture();
    try {
      await fixture.prepare();
      const before = AliasFixture.descriptors(), custody = await fixture.open();
      closeSync(fixture.descriptor());
      assert.throws(custody.close.bind(custody), { message: 'KATA_RUNTIME_ALIASES_CLOSE_FAILED' });
      assert.throws(custody.close.bind(custody), { message: 'KATA_RUNTIME_ALIASES_CLOSE_FAILED' });
      fixture.held.length = 0;
      assert.equal(AliasFixture.descriptors(), before);
      fixture.components!.verify();
    } finally { fixture.close(); }
  }
}
const suite = new AliasBoundaries();
for (const mode of ['relative','noncanonical','wrong-root','target','regular','parent-mode','root-mode','ancestor','closed-components','cancelled'])
  test('integration: installed runtime alias admission rejects ' + mode + ' without leaking custody', suite.rejected.bind(suite, mode));
for (const mode of ['same-target','target','parent','parent-mode','root-mode','bytes','components','archive'])
  test('integration: retained runtime alias custody fences changed ' + mode, suite.changed.bind(suite, mode));
for (const mode of ['cancel','replace'])
  test('integration: installed runtime alias capture rejects asynchronous ' + mode + ' and releases descriptors', suite.interruption.bind(suite, mode));
test('integration: installed runtime alias proof binds exact immutable sorted paths and canonical digest', suite.proof.bind(suite));
test('integration: runtime alias disposal releases only owned custody and fences subsequent reads', suite.disposal.bind(suite));
test('integration: failed alias disposal drains remaining descriptors and stays failed', suite.failedClose.bind(suite));

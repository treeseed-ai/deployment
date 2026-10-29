import assert from 'node:assert/strict';
import { test } from 'bun:test';
import {
  appendFileSync,
  chmodSync,
  symlinkSync,
  unlinkSync,
  copyFileSync,
  readdirSync,
  readlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { RuntimeArchiveCustody } from '@treeseed-cordis/deployment/sandbox';
import {
  ComponentFixture,
  type ComponentBindings,
  type ComponentCustody,
} from '../support/runtime-components-program.js';
class InstalledComponentBoundaries {
  private readonly signal = new AbortController().signal;
  async rejected(mode: string): Promise<void> {
    const fixture = new ComponentFixture();
    const archive = await RuntimeArchiveCustody.open(fixture.input, this.signal);
    try {
      const bindings = this.invalid(fixture, mode);
      const signal = mode === 'cancelled' ? AbortSignal.abort() : this.signal;
      const Constructor = fixture.constructorExport();
      const retained = this.descriptors(fixture.installed);
      await assert.rejects(Constructor.open.bind(Constructor, archive, bindings, signal), {
        message: mode === 'cancelled' ? 'KATA_CANCELLED' : 'KATA_COMPONENTS_INVALID',
      });
      archive.verify();
      assert.equal(this.descriptors(fixture.installed), retained);
    } finally {
      archive.close();
      fixture.close();
    }
  }
  private descriptors(path: string): number {
    let count = 0;
    for (const file of readdirSync('/proc/self/fd')) {
      try {
        if (readlinkSync('/proc/self/fd/' + file) === path) count++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return count;
  }
  private invalid(fixture: ComponentFixture, mode: string): unknown {
    const bindings = structuredClone(fixture.bindings);
    if (mode === 'empty') return [];
    if (mode === 'unknown') return [{ ...bindings[0], execute: true }];
    if (mode === 'duplicate') return [...bindings, ...bindings];
    if (mode === 'relative') bindings[0]!.path = 'PRIVATE_COMPONENT_PATH';
    if (mode === 'missing-member') bindings[0]!.member = 'opt/kata/missing';
    if (mode === 'bytes') appendFileSync(fixture.installed, 'PRIVATE_COMPONENT_CANARY');
    if (mode === 'mode') chmodSync(fixture.installed, 0o644);
    if (mode === 'symlink') this.replaceLink(fixture);
    if (mode === 'ancestor') this.aliasDirectory(fixture, bindings);
    if (mode === 'partial') this.partial(fixture, bindings);
    return bindings;
  }
  private replaceLink(fixture: ComponentFixture): void {
    const target = join(fixture.directory, 'other');
    copyFileSync(fixture.installed, target);
    unlinkSync(fixture.installed);
    symlinkSync(target, fixture.installed);
  }
  private aliasDirectory(fixture: ComponentFixture, bindings: ComponentBindings[]): void {
    const alias = join(fixture.directory, 'alias');
    symlinkSync(fixture.directory, alias);
    bindings[0]!.path = join(alias, 'PRIVATE_COMPONENT_PATH');
  }
  private partial(fixture: ComponentFixture, bindings: ComponentBindings[]): void {
    const path = join(fixture.directory, 'second');
    copyFileSync(fixture.installed, path);
    chmodSync(path, 0o644);
    bindings.push({ role: 'kernel', member: 'opt/kata/bin/component', path });
  }
  async changed(mode: string): Promise<void> {
    const fixture = new ComponentFixture();
    const archive = await RuntimeArchiveCustody.open(fixture.input, this.signal);
    let components: ComponentCustody | null = null;
    try {
      components = await fixture.constructorExport().open(archive, fixture.bindings, this.signal);
      this.mutate(fixture, archive, mode);
      assert.throws(components.verify.bind(components), { message: 'KATA_COMPONENTS_CHANGED' });
    } finally {
      components?.close();
      archive.close();
      fixture.close();
    }
  }
  private mutate(fixture: ComponentFixture, archive: RuntimeArchiveCustody, mode: string): void {
    if (mode === 'bytes') appendFileSync(fixture.installed, 'PRIVATE_COMPONENT_CANARY');
    if (mode === 'mode') chmodSync(fixture.installed, 0o644);
    if (mode === 'symlink') this.replaceLink(fixture);
    if (mode === 'archive') archive.close();
  }
  async snapshot(): Promise<void> {
    const fixture = new ComponentFixture();
    const archive = await RuntimeArchiveCustody.open(fixture.input, this.signal);
    let components: ComponentCustody | null = null;
    try {
      const pending = fixture.constructorExport().open(archive, fixture.bindings, this.signal);
      fixture.bindings[0]!.path = '/PRIVATE_COMPONENT_CANARY';
      components = await pending;
      components.verify();
      assert(!JSON.stringify(components.proof).includes('PRIVATE_COMPONENT_CANARY'));
    } finally {
      components?.close();
      archive.close();
      fixture.close();
    }
  }
}
const suite = new InstalledComponentBoundaries();
for (const mode of [
  'empty',
  'unknown',
  'duplicate',
  'relative',
  'missing-member',
  'bytes',
  'mode',
  'symlink',
  'ancestor',
  'partial',
  'cancelled',
])
  test(
    'integration: installed kit component admission rejects ' + mode + ' without adopting state',
    suite.rejected.bind(suite, mode),
  );
for (const mode of ['bytes', 'mode', 'symlink', 'archive'])
  test(
    'integration: retained installed kit component identity fences changed ' + mode,
    suite.changed.bind(suite, mode),
  );
test(
  'integration: installed component admission snapshots caller selections before asynchronous kit reads',
  suite.snapshot.bind(suite),
);

import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { appendFileSync, copyFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigurationFixture } from '../support/runtime-configuration-program.js';
class RuntimeConfigurationBoundaries {
  async rejected(mode: string): Promise<void> {
    const fixture = new ConfigurationFixture(this.text(mode));
    try {
      const reader = fixture.reader();
      if (mode === 'missing-role') fixture.bindings.pop();
      await fixture.start();
      this.mutate(fixture, mode);
      const file = { ...fixture.file };
      if (mode === 'digest') file.sha256 = 'a'.repeat(64);
      if (mode === 'unknown') Object.assign(file, { execute: true });
      const signal = mode === 'cancelled' ? AbortSignal.abort() : new AbortController().signal;
      await assert.rejects(reader.inspect.bind(reader, file, fixture.components!, signal), {
        message: mode === 'cancelled' ? 'KATA_CANCELLED' : 'KATA_CONFIGURATION_INVALID',
      });
    } finally {
      fixture.close();
    }
  }
  private text(mode: string): string | Buffer {
    const base = ConfigurationFixture.text;
    if (mode === 'duplicate') return base + '\n[runtime]\n';
    if (mode === 'unsafe-key') return base + '\n[__proto__]\na = 1\n';
    if (mode === 'non-finite') return base + '\n[unused]\na = inf\n';
    if (mode === 'wrong-path')
      return base.replace('/opt/kata/kernel', '/PRIVATE_CONFIGURATION_CANARY');
    if (mode === 'other-hypervisor') return base + '\n[hypervisor.clh]\npath = "other"\n';
    if (mode === 'other-agent') return base.replace('agent_name = "kata"', 'agent_name = "other"');
    if (mode === 'missing-table') return base.replace('[agent.kata.mem_agent]', '[other]');
    if (mode === 'bad-utf8') return Buffer.concat([Buffer.from(base), Buffer.from([0xff])]);
    if (mode === 'oversized') return base + '#' + 'x'.repeat(1024 * 1024);
    if (mode === 'deep-inline')
      return base + '\n[unused]\na = ' + '['.repeat(33) + '1' + ']'.repeat(33);
    return base;
  }
  private mutate(fixture: ConfigurationFixture, mode: string): void {
    if (mode === 'changed') appendFileSync(fixture.file.path, 'PRIVATE_CONFIGURATION_CANARY');
    if (mode === 'closed') fixture.components!.close();
    if (mode !== 'symlink') return;
    const copy = join(fixture.directory, 'copy');
    copyFileSync(fixture.file.path, copy);
    unlinkSync(fixture.file.path);
    symlinkSync(copy, fixture.file.path);
  }
}
const suite = new RuntimeConfigurationBoundaries();
for (const mode of [
  'missing-role',
  'digest',
  'unknown',
  'cancelled',
  'duplicate',
  'unsafe-key',
  'non-finite',
  'wrong-path',
  'other-hypervisor',
  'other-agent',
  'missing-table',
  'bad-utf8',
  'oversized',
  'deep-inline',
  'changed',
  'closed',
  'symlink',
])
  test(
    'integration: verified runtime configuration rejects ' + mode + ' safely',
    suite.rejected.bind(suite, mode),
  );

import { test } from 'bun:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  chmodSync,
  linkSync,
  symlinkSync,
  unlinkSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import {
  RuntimeArchiveFixture,
  type RuntimeArchiveHandle,
} from '../support/runtime-archive-program.js';
class RuntimeArchiveBoundaries {
  async rejects(mode: string): Promise<void> {
    const fixture = new RuntimeArchiveFixture();
    try {
      this.corrupt(fixture, mode);
      const api = await RuntimeArchiveFixture.api();
      const input = {
        ...fixture.input,
        ...(mode === 'hash' ? { sha256: '0'.repeat(64) } : {}),
        ...(mode === 'size' ? { size: fixture.input.size + 1 } : {}),
      };
      await assert.rejects(api.open(input, new AbortController().signal), {
        code: 'KATA_RUNTIME_ARCHIVE_INVALID',
      });
    } finally {
      fixture.close();
    }
  }
  private corrupt(fixture: RuntimeArchiveFixture, mode: string): void {
    if (mode === 'permissions') chmodSync(fixture.path, 0o644);
    if (mode === 'hardlink') linkSync(fixture.path, fixture.path + '.link');
    if (mode === 'symlink') {
      unlinkSync(fixture.path);
      symlinkSync('missing', fixture.path);
    }
    if (mode === 'directory') {
      unlinkSync(fixture.path);
      mkdirSync(fixture.path, { mode: 0o700 });
    }
    if (mode === 'magic') {
      const bytes = Buffer.alloc(fixture.input.size);
      writeFileSync(fixture.path, bytes);
      fixture.input.sha256 = createHash('sha256').update(bytes).digest('hex');
    }
  }
  async changes(mode: string): Promise<void> {
    const fixture = new RuntimeArchiveFixture();
    let file: RuntimeArchiveHandle | null = null;
    try {
      file = await fixture.open();
      if (mode === 'append') appendFileSync(fixture.path, 'private-canary');
      if (mode === 'chmod') chmodSync(fixture.path, 0o644);
      if (mode === 'hardlink') linkSync(fixture.path, fixture.path + '.link');
      assert.throws(file.verify.bind(file), { code: 'KATA_RUNTIME_ARCHIVE_CHANGED' });
    } finally {
      file?.close();
      fixture.close();
    }
  }
  async cancelled(): Promise<void> {
    const fixture = new RuntimeArchiveFixture();
    const controller = new AbortController();
    try {
      const pending = fixture.open(controller.signal);
      controller.abort();
      await assert.rejects(pending, { code: 'KATA_CANCELLED' });
    } finally {
      fixture.close();
    }
  }
  async snapshots(): Promise<void> {
    const fixture = new RuntimeArchiveFixture();
    let file: RuntimeArchiveHandle | null = null;
    try {
      const api = await RuntimeArchiveFixture.api();
      const input = { ...fixture.input };
      const pending = api.open(input, new AbortController().signal);
      input.sha256 = '0'.repeat(64);
      file = await pending;
      assert.equal(file.proof.sha256, fixture.input.sha256);
      file.verify();
    } finally {
      file?.close();
      fixture.close();
    }
  }
}
const suite = new RuntimeArchiveBoundaries();
for (const mode of ['hash', 'size', 'permissions', 'hardlink', 'symlink', 'directory', 'magic'])
  test('integration: runtime archive admission rejects ' + mode, suite.rejects.bind(suite, mode));
for (const mode of ['append', 'chmod', 'hardlink'])
  test(
    'integration: retained runtime archive refuses later ' + mode,
    suite.changes.bind(suite, mode),
  );
test(
  'integration: runtime archive cancellation cannot publish verified custody',
  suite.cancelled.bind(suite),
);
test(
  'integration: runtime archive captures declared identity before asynchronous hashing',
  suite.snapshots.bind(suite),
);

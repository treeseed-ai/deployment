import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { appendFileSync } from 'node:fs';
import { RuntimeKitFixture } from '../support/runtime-kit-members-program.js';
class RuntimeKitMemberBoundaries {
  async rejects(mode: string): Promise<void> {
    const fixture = new RuntimeKitFixture(mode);
    const custody = await fixture.open();
    try {
      await assert.rejects(
        custody.inspect([RuntimeKitFixture.link], new AbortController().signal),
        {
          code: 'KATA_RUNTIME_KIT_INVALID',
        },
      );
      custody.verify();
    } finally {
      custody.close();
      fixture.close();
    }
  }
  async selection(paths: unknown): Promise<void> {
    const fixture = new RuntimeKitFixture();
    const custody = await fixture.open();
    try {
      await assert.rejects(custody.inspect(paths, new AbortController().signal), {
        code: 'KATA_RUNTIME_KIT_INVALID',
      });
    } finally {
      custody.close();
      fixture.close();
    }
  }
  async snapshot(): Promise<void> {
    const fixture = new RuntimeKitFixture();
    const custody = await fixture.open();
    try {
      const paths = [RuntimeKitFixture.link];
      const pending = custody.inspect(paths, new AbortController().signal);
      paths[0] = 'opt/kata/missing';
      assert.equal((await pending).members[0]!.requestedPath, RuntimeKitFixture.link);
    } finally {
      custody.close();
      fixture.close();
    }
  }
  async interrupted(mode: string): Promise<void> {
    const fixture = new RuntimeKitFixture();
    const custody = await fixture.open();
    const controller = new AbortController();
    try {
      const pending = custody.inspect([RuntimeKitFixture.link], controller.signal);
      if (mode === 'cancelled') controller.abort();
      else appendFileSync(fixture.path, 'PRIVATE_KIT_CANARY');
      await assert.rejects(pending, {
        code: mode === 'cancelled' ? 'KATA_CANCELLED' : 'KATA_RUNTIME_ARCHIVE_CHANGED',
      });
    } finally {
      custody.close();
      fixture.close();
    }
  }
  async lifetime(mode: string): Promise<void> {
    const fixture = new RuntimeKitFixture();
    const custody = await fixture.open();
    const controller = new AbortController();
    try {
      if (mode === 'closed') custody.close();
      if (mode === 'changed') appendFileSync(fixture.path, 'PRIVATE_KIT_CANARY');
      if (mode === 'cancelled') controller.abort();
      await assert.rejects(custody.inspect([RuntimeKitFixture.link], controller.signal), {
        code:
          mode === 'closed'
            ? 'KATA_RUNTIME_ARCHIVE_CLOSED'
            : mode === 'changed'
              ? 'KATA_RUNTIME_ARCHIVE_CHANGED'
              : 'KATA_CANCELLED',
      });
    } finally {
      custody.close();
      fixture.close();
    }
  }
}
const suite = new RuntimeKitMemberBoundaries();
for (const mode of [
  'duplicate',
  'unsafe',
  'special',
  'permissions',
  'ancestor',
  'escape',
  'cycle',
  'truncated',
  'garbage',
  'checksum',
  'truncated-zstd',
  'ratio',
  'entries',
  'metadata',
  'metadata-excess',
  'oversized-metadata',
  'ignored',
  'tar-tail',
  'long-empty',
  'long-extra',
  'long-dangling',
  'long-duplicate',
  'long-wrong-kind',
  'control-entries',
])
  test('integration: retained kit inspection refuses ' + mode, suite.rejects.bind(suite, mode));
for (const paths of [
  [],
  ['opt/kata/missing'],
  ['opt/kata/bin/../fixture'],
  ['/opt/kata/bin/fixture'],
  [RuntimeKitFixture.file, RuntimeKitFixture.file],
  Array(17).fill(RuntimeKitFixture.file),
  null,
])
  test(
    'integration: retained kit inspection rejects selection ' + JSON.stringify(paths),
    suite.selection.bind(suite, paths),
  );
for (const mode of ['closed', 'changed', 'cancelled'])
  test(
    'integration: retained kit inspection preserves ' + mode + ' custody boundary',
    suite.lifetime.bind(suite, mode),
  );
test(
  'integration: asynchronous kit inspection snapshots its exact selected paths',
  suite.snapshot.bind(suite),
);
for (const mode of ['cancelled', 'changed'])
  test(
    'integration: in-progress kit inspection cannot accept ' + mode + ' custody',
    suite.interrupted.bind(suite, mode),
  );

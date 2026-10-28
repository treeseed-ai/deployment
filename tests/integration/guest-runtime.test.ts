import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync, symlinkSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { GuestRuntimeFixture as Fixture } from '../support/guest-runtime-program.js';
class GuestRuntimeIntegration {
  async custody(): Promise<void> {
    const fixture = await new Fixture().prepare();
    try {
      const reader = fixture.reader();
      chmodSync(fixture.archive, 0o644);
      await assert.rejects(reader.read(new AbortController().signal), {
        message: 'KATA_GUEST_ARTIFACT_INVALID',
      });
      chmodSync(fixture.archive, 0o600);
      unlinkSync(fixture.archive);
      symlinkSync(join(fixture.root, 'missing-canary'), fixture.archive);
      await assert.rejects(reader.read(new AbortController().signal), {
        message: 'KATA_GUEST_ARTIFACT_INVALID',
      });
      assert.equal(existsSync(fixture.canary), false);
    } finally {
      fixture.close();
    }
  }
  async tampering(): Promise<void> {
    const fixture = await new Fixture().prepare();
    try {
      const reader = fixture.reader();
      writeFileSync(fixture.archive, Buffer.from('private-output-canary'));
      await assert.rejects(reader.read(new AbortController().signal), {
        message: 'KATA_GUEST_ARTIFACT_INVALID',
      });
      assert.equal(existsSync(fixture.canary), false);
    } finally {
      fixture.close();
    }
  }
  async members(): Promise<void> {
    const fixture = await new Fixture().prepare();
    try {
      writeFileSync(
        join(fixture.source, 'package/dist/bin/trsd-agent-guest.999.gzpart'),
        'unlisted',
      );
      await fixture.pack();
      await assert.rejects(fixture.reader().read(new AbortController().signal), {
        message: 'KATA_GUEST_ARTIFACT_INVALID',
      });
      assert.equal(existsSync(fixture.canary), false);
    } finally {
      fixture.close();
    }
  }
  async payload(): Promise<void> {
    const fixture = await new Fixture().prepare();
    try {
      const value = fixture.manifest;
      const targets = [value.executable, value.compressed, value.compressed.parts[0]!];
      for (const target of targets) {
        const digest = target.sha256;
        target.sha256 = 'f'.repeat(64);
        await fixture.refresh();
        await assert.rejects(fixture.reader().read(new AbortController().signal), {
          message: 'KATA_GUEST_ARTIFACT_INVALID',
        });
        target.sha256 = digest;
      }
    } finally {
      fixture.close();
    }
  }
  async binding(): Promise<void> {
    const fixture = await new Fixture().prepare();
    try {
      const wrong = {
        ...fixture.configuration(),
        package: { name: '@foreign/guest', version: '1.0.0' },
      };
      await assert.rejects(fixture.reader(wrong).read(new AbortController().signal), {
        message: 'KATA_GUEST_ARTIFACT_INVALID',
      });
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(fixture.reader().read(controller.signal), { message: 'KATA_CANCELLED' });
    } finally {
      fixture.close();
    }
  }
}
const suite = new GuestRuntimeIntegration();
test(
  'integration: guest artifact custody rejects nonprivate and symlink files without host effects',
  suite.custody.bind(suite),
  120000,
);
test(
  'integration: guest artifact read-back rejects changed archive bytes safely',
  suite.tampering.bind(suite),
  120000,
);
test(
  'integration: guest artifact rejects undeclared runtime chunks inside genuine archives',
  suite.members.bind(suite),
  120000,
);
test(
  'integration: guest artifact binds package identity and cancellation before admission',
  suite.binding.bind(suite),
  120000,
);

test(
  'integration: coherent outer guest archives cannot hide changed part stream or executable identities',
  suite.payload.bind(suite),
  120000,
);

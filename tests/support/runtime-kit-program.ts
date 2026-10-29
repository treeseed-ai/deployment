import assert from 'node:assert/strict';
import { KataSandboxPlugin } from '@treeseed-cordis/deployment/sandbox';
/** Declarative host configuration only; no VM, daemon, store or runtime file access. */
class RuntimeKitProgram {
  private static readonly file = { path: '/fixture/unused', sha256: 'a'.repeat(64) };
  private static readonly archive = {
    path: '/fixture/runtime.tar.zst',
    size: 969565384,
    sha256: '3dc6b69c4acb787b967b04b64599a20d02a8beb1a8eaab3084110df9d0b08c96',
  };
  private static readonly configuration = {
    scope: { installationId: 'fixture', serviceId: 'worker', providerGeneration: this.file.sha256 },
    custody: '/fixture/custody',
    endpointDirectory: '/fixture/endpoint',
    daemon: { pid: 12345, startTime: '123', commandDigest: this.file.sha256 },
    client: this.file,
    runtime: {
      version: '4.1.0',
      guestKernel: '6.18.35',
      shim: this.file,
      hypervisor: this.file,
      configuration: this.file,
      archive: this.archive,
    },
    image: 'busybox@sha256:' + 'b'.repeat(64),
  };
  run(): void {
    assert.equal(KataSandboxPlugin.Config.safeParse(RuntimeKitProgram.configuration).success, true);
    for (const archive of [
      null,
      {},
      { ...RuntimeKitProgram.archive, size: 0 },
      { ...RuntimeKitProgram.archive, execute: true },
    ])
      assert.equal(KataSandboxPlugin.Config.safeParse(this.configuration(archive)).success, false);
    assert.equal(KataSandboxPlugin.Config.safeParse(this.configuration(undefined)).success, true);
    process.stdout.write('kata-runtime-kit-interface-ok\n');
  }
  private configuration(archive: unknown): object {
    const configuration = RuntimeKitProgram.configuration;
    return { ...configuration, runtime: { ...configuration.runtime, archive } };
  }
}
if (import.meta.main) new RuntimeKitProgram().run();

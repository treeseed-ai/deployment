import assert from 'node:assert/strict';
import { Header } from 'tar';
import { zstdCompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Sandbox from '@treeseed-cordis/deployment/sandbox';
interface ComponentCustody {
  readonly proof: object;
  verify(): void;
  close(): void;
}
interface ComponentConstructor {
  open(
    archive: Sandbox.RuntimeArchiveCustody,
    bindings: unknown,
    signal: AbortSignal,
  ): Promise<ComponentCustody>;
}
interface ConfigurationReader {
  inspect(
    file: unknown,
    components: ComponentCustody,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>>;
}
/** Genuine small kit, installed files and TOML data. Never an executable runtime. */
export class ConfigurationFixture {
  readonly directory = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-configuration-')));
  readonly file = { path: join(this.directory, 'PRIVATE_CONFIGURATION_PATH'), sha256: '' };
  readonly bindings: Array<{ role: string; member: string; path: string }> = [];
  readonly input: { path: string; sha256: string; size: number };
  archive: Sandbox.RuntimeArchiveCustody | null = null;
  components: ComponentCustody | null = null;
  static readonly text = `
[hypervisor.qemu]
path = "/opt/kata/bin/qemu"
kernel = "/opt/kata/kernel"
image = "/opt/kata/rootfs"
virtio_fs_daemon = "/opt/kata/bin/virtiofs"
default_vcpus = 1
default_maxvcpus = 0
default_memory = 2048
default_maxmemory = 0
overhead_vcpus = 0.2
overhead_memory = 32
memory_slots = 10
[runtime]
hypervisor_name = "qemu"
agent_name = "kata"
static_sandbox_resource_mgmt = true
[agent.kata.mem_agent]
compact_force_times = 9223372036854775807
`;
  constructor(text: string | Buffer = ConfigurationFixture.text) {
    const parts: Buffer[] = [];
    this.component(parts, 'configuration', 'opt/kata/config/runtime.toml', Buffer.from(text));
    this.component(parts, 'hypervisor', 'opt/kata/bin/qemu', Buffer.from('QEMU fixture data'));
    this.component(parts, 'kernel', 'opt/kata/kernel', Buffer.from('kernel fixture data'));
    this.component(parts, 'rootfs', 'opt/kata/rootfs', Buffer.from('rootfs fixture data'));
    this.component(
      parts,
      'virtiofs',
      'opt/kata/bin/virtiofs',
      Buffer.from('virtiofs fixture data'),
    );
    const bytes = zstdCompressSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
    const path = join(this.directory, 'kit.tar.zst');
    writeFileSync(path, bytes, { mode: 0o600 });
    this.input = { path, size: bytes.length, sha256: this.digest(bytes) };
  }
  private component(parts: Buffer[], role: string, member: string, bytes: Buffer): void {
    const path = role === 'configuration' ? this.file.path : join(this.directory, role);
    writeFileSync(path, bytes, { mode: 0o644 });
    chmodSync(path, 0o644);
    if (role === 'configuration') this.file.sha256 = this.digest(bytes);
    this.bindings.push({ role, member, path });
    const header = Buffer.alloc(512);
    new Header({ type: 'File', path: member, mode: 0o644, size: bytes.length }).encode(header);
    parts.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  private digest(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
  }
  async start(): Promise<void> {
    this.archive = await Sandbox.RuntimeArchiveCustody.open(
      this.input,
      new AbortController().signal,
    );
    const Constructor = Reflect.get(Sandbox, 'RuntimeComponentCustody') as
      | ComponentConstructor
      | undefined;
    assert(
      Constructor && typeof Constructor.open === 'function',
      'Accepted component custody required',
    );
    this.components = await Constructor.open(
      this.archive,
      this.bindings,
      new AbortController().signal,
    );
  }
  reader(): ConfigurationReader {
    const Reader = Reflect.get(Sandbox, 'KataRuntimeConfiguration') as
      | ConfigurationReader
      | undefined;
    assert(
      Reader && typeof Reader.inspect === 'function',
      'Public runtime configuration reader missing',
    );
    return Reader;
  }
  close(): void {
    try {
      this.components?.close();
    } finally {
      this.archive?.close();
      rmSync(this.directory, { recursive: true, force: true });
    }
  }
}
class ConfigurationProgram {
  async run(): Promise<void> {
    const fixture = new ConfigurationFixture();
    try {
      const reader = fixture.reader();
      await fixture.start();
      const result = await reader.inspect(
        fixture.file,
        fixture.components!,
        new AbortController().signal,
      );
      this.proof(result);
      fixture.components!.verify();
      fixture.archive!.verify();
      assert(!JSON.stringify(result).includes('PRIVATE_CONFIGURATION_PATH'));
    } finally {
      fixture.close();
    }
    process.stdout.write('runtime-configuration-public-ok\n');
  }
  private proof(result: Record<string, unknown>): void {
    assert.equal(result.kind, 'kata-runtime-references');
    assert.equal(result.formatVersion, 1);
    assert(Object.isFrozen(result));
    assert.deepEqual(result.resources, {
      defaultVcpus: 1,
      maximumVcpus: 0,
      defaultMemoryMiB: 2048,
      maximumMemoryMiB: 0,
      overheadVcpus: 0.2,
      overheadMemoryMiB: 32,
      memorySlots: 10,
      staticSandboxResourceManagement: true,
    });
  }
}
if (import.meta.main) await new ConfigurationProgram().run();

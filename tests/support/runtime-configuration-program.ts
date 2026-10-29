import assert from 'node:assert/strict';
import { Header } from 'tar';
import { zstdCompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  chmodSync,
  rmSync,
  copyFileSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Sandbox from '@treeseed-cordis/deployment/sandbox';
type ComponentCustody = Sandbox.RuntimeComponentCustody;
interface ComponentConstructor {
  open(
    archive: Sandbox.RuntimeArchiveCustody,
    bindings: unknown,
    signal: AbortSignal,
  ): Promise<ComponentCustody>;
}
type ConfigurationReader = typeof Sandbox.KataRuntimeConfiguration;
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
  actual(source: string): void {
    assert(lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink());
    copyFileSync(source, this.input.path);
    chmodSync(this.input.path, 0o600);
    this.input.sha256 = '3dc6b69c4acb787b967b04b64599a20d02a8beb1a8eaab3084110df9d0b08c96';
    this.input.size = 969565384;
    this.bindings.splice(0, this.bindings.length, ...ActualConfigurationProgram.bindings);
    this.file.path = ActualConfigurationProgram.configuration;
    this.file.sha256 = '870f8157d298a51784d3617854456edf16820bbc1e743b15467e441b63c43673';
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
  private proof(result: Sandbox.KataRuntimeReferences): void {
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
/** Hosted installed upstream bytes only. No extraction, process or VM activation. */
class ActualConfigurationProgram {
  static readonly configuration =
    '/opt/kata/share/defaults/kata-containers/runtime-rs/configuration-qemu-runtime-rs.toml';
  static readonly bindings = [
    { role: 'configuration', member: this.configuration.slice(1), path: this.configuration },
    {
      role: 'hypervisor',
      member: 'opt/kata/bin/qemu-system-x86_64',
      path: '/opt/kata/bin/qemu-system-x86_64',
    },
    {
      role: 'kernel',
      member: 'opt/kata/share/kata-containers/vmlinux.container',
      path: '/opt/kata/share/kata-containers/vmlinux-6.18.35-202',
    },
    {
      role: 'rootfs',
      member: 'opt/kata/share/kata-containers/kata-containers.img',
      path: '/opt/kata/share/kata-containers/kata-ubuntu-noble.image',
    },
    { role: 'virtiofs', member: 'opt/kata/libexec/virtiofsd', path: '/opt/kata/libexec/virtiofsd' },
  ];
  async run(): Promise<void> {
    const fixture = new ConfigurationFixture();
    try {
      fixture.actual(process.argv[3]!);
      await fixture.start();
      const proof = await fixture
        .reader()
        .inspect(fixture.file, fixture.components!, new AbortController().signal);
      this.proof(proof);
      fixture.components!.verify();
    } finally {
      fixture.close();
    }
    process.stdout.write('runtime-configuration-upstream-ok\n');
  }
  private proof(proof: Sandbox.KataRuntimeReferences): void {
    assert.equal(
      proof.configuration.sha256,
      '870f8157d298a51784d3617854456edf16820bbc1e743b15467e441b63c43673',
    );
    assert.deepEqual(proof.resources, {
      defaultVcpus: 1,
      maximumVcpus: 0,
      defaultMemoryMiB: 2048,
      maximumMemoryMiB: 0,
      overheadVcpus: 0.2,
      overheadMemoryMiB: 32,
      memorySlots: 10,
      staticSandboxResourceManagement: true,
    });
    assert.equal(proof.references.length, 4);
    assert(proof.references.some(this.linked));
  }
  private linked(reference: Sandbox.KataRuntimeReferences['references'][number]): boolean {
    return reference.member.links.length > 0;
  }
}
if (import.meta.main) {
  if (process.argv[2] === 'actual') await new ActualConfigurationProgram().run();
  else await new ConfigurationProgram().run();
}

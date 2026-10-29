import assert from 'node:assert/strict';
import { Header, type HeaderData } from 'tar';
import { zstdCompressSync } from 'node:zlib';
import {
  mkdtempSync,
  writeFileSync,
  realpathSync,
  rmSync,
  copyFileSync,
  chmodSync,
  lstatSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { RuntimeArchiveCustody } from '@treeseed-cordis/deployment/sandbox';
export type { RuntimeKitMembers as KitMembers } from '@treeseed-cordis/deployment/sandbox';
import type { RuntimeKitMembers as KitMembers } from '@treeseed-cordis/deployment/sandbox';
export interface KitCustody {
  inspect(paths: unknown, signal: AbortSignal): Promise<KitMembers>;
}
/** Genuine small Zstandard tar data; never an executable Kata kit or host setup script. */
export class RuntimeKitFixture {
  readonly directory = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-kit-members-')));
  readonly path = join(this.directory, 'fixture.tar.zst');
  readonly input: { path: string; size: number; sha256: string };
  static readonly content = Buffer.from('explicit runtime component fixture\n');
  static readonly file = 'opt/kata/bin/fixture';
  static readonly link = 'opt/kata/bin/selected';
  static readonly alias = 'opt/kata/bin/alias';
  static readonly actualIdentity = {
    sha256: '3dc6b69c4acb787b967b04b64599a20d02a8beb1a8eaab3084110df9d0b08c96',
    size: 969565384,
  };
  constructor(mode = 'valid', source?: string) {
    const bytes = this.bytes(mode);
    writeFileSync(this.path, bytes, { mode: 0o600 });
    this.input = { path: this.path, size: bytes.length, sha256: RuntimeKitFixture.digest(bytes) };
    if (mode === 'actual') this.actual(source);
  }
  private actual(source: string | undefined): void {
    assert.equal(typeof source, 'string', 'Actual kit inspection requires the pinned archive');
    const stat = lstatSync(source!);
    assert(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(stat.size, RuntimeKitFixture.actualIdentity.size);
    copyFileSync(source!, this.path);
    chmodSync(this.path, 0o600);
    Object.assign(this.input, RuntimeKitFixture.actualIdentity);
  }
  static digest(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
  }
  private bytes(mode: string): Buffer {
    const parts = this.members(mode);
    if (mode === 'checksum') parts[0]![0] = parts[0]![0]! ^ 1;
    if (mode !== 'truncated') parts.push(Buffer.alloc(1024));
    if (mode === 'tar-tail') parts.push(Buffer.from('PRIVATE_KIT_CANARY'));
    const bytes = zstdCompressSync(Buffer.concat(parts));
    if (mode === 'truncated-zstd') return bytes.subarray(0, -1);
    return mode === 'garbage' ? Buffer.concat([bytes, Buffer.from('PRIVATE_KIT_CANARY')]) : bytes;
  }
  private members(mode: string): Buffer[] {
    const parts = [...this.baseline(mode), ...this.links(mode)];
    if (mode === 'duplicate') parts.push(parts[0]!);
    if (mode === 'unsafe') parts.push(this.entry({ path: 'opt/kata/../outside' }));
    if (mode === 'special')
      parts.push(this.entry({ path: 'opt/kata/device', type: 'CharacterDevice' }));
    if (mode === 'permissions') parts.push(this.entry({ path: 'opt/kata/writable', mode: 0o666 }));
    if (mode === 'ancestor') parts.push(this.entry({ path: RuntimeKitFixture.link + '/child' }));
    parts.push(...this.expansion(mode), ...this.auxiliary(mode));
    return parts;
  }
  private baseline(mode: string): Buffer[] {
    const path = mode === 'long-path' ? 'opt/kata/raw-placeholder' : RuntimeKitFixture.file;
    const file = this.entry({ path, mode: 0o755 }, RuntimeKitFixture.content);
    if (mode !== 'long-path') return [file];
    return [this.control('NextFileHasLongPath', './' + RuntimeKitFixture.file + '\0'), file];
  }
  private control(type: HeaderData['type'], value: string): Buffer {
    return this.entry({ path: '././@LongLink', type }, Buffer.from(value));
  }
  private links(mode: string): Buffer[] {
    const parts: Buffer[] = [];
    const target =
      mode === 'escape' ? '../../../../outside' : mode === 'cycle' ? 'alias' : 'fixture';
    if (mode === 'long-link') parts.push(this.control('NextFileHasLongLinkpath', 'fixture\0'));
    parts.push(
      this.entry({
        path: RuntimeKitFixture.link,
        type: 'SymbolicLink',
        linkpath: mode === 'long-link' ? 'placeholder' : target,
      }),
    );
    parts.push(
      this.entry({ path: RuntimeKitFixture.alias, type: 'SymbolicLink', linkpath: 'selected' }),
    );
    return parts;
  }
  private expansion(mode: string): Buffer[] {
    const parts: Buffer[] = [];
    if (mode === 'ratio')
      parts.push(this.entry({ path: 'opt/kata/repetition' }, Buffer.alloc(65536)));
    if (mode === 'entries')
      for (let index = 0; index < 4096; index++)
        parts.push(this.entry({ path: 'opt/kata/file-' + index }, randomBytes(32)));
    return parts;
  }
  private auxiliary(mode: string): Buffer[] {
    const parts: Buffer[] = [];
    if (mode === 'metadata')
      parts.push(this.entry({ path: 'opt/kata/metadata', type: 'ExtendedHeader' }));
    if (mode === 'oversized-metadata')
      parts.push(
        this.entry({ path: 'opt/kata/metadata', type: 'ExtendedHeader' }, randomBytes(65537)),
      );
    if (mode === 'ignored')
      parts.push(this.entry({ path: 'opt/kata/ignored', type: 'SolarisACL' }));
    if (mode === 'metadata-excess')
      for (let index = 0; index < 4096; index++)
        parts.push(
          this.entry({
            path: 'opt/kata/meta-' + randomBytes(16).toString('hex'),
            type: 'ExtendedHeader',
          }),
        );
    return parts;
  }
  private entry(input: HeaderData, bytes = Buffer.alloc(0)): Buffer {
    const header = Buffer.alloc(512);
    new Header({ type: 'File', mode: 0o644, size: bytes.length, ...input }).encode(header);
    return Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
  }
  async open(): Promise<RuntimeArchiveCustody & KitCustody> {
    const custody = await RuntimeArchiveCustody.open(this.input, new AbortController().signal);
    try {
      assert.equal(
        typeof Reflect.get(custody, 'inspect'),
        'function',
        'public retained kit inspection missing',
      );
      return custody as RuntimeArchiveCustody & KitCustody;
    } catch (error) {
      custody.close();
      throw error;
    }
  }
  close(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
}
class RuntimeKitMembersProgram {
  async run(): Promise<void> {
    const mode = process.argv[2] ?? 'valid';
    const fixture = new RuntimeKitFixture(mode, process.argv[3]);
    const custody = await fixture.open();
    try {
      if (mode === 'garbage')
        await assert.rejects(
          custody.inspect([RuntimeKitFixture.link], new AbortController().signal),
          { code: 'KATA_RUNTIME_KIT_INVALID' },
        );
      else if (mode === 'actual') await this.actual(custody);
      else await this.valid(custody, fixture);
      custody.verify();
    } finally {
      custody.close();
      fixture.close();
    }
    process.stdout.write('runtime-kit-members-ok\n');
  }
  private static readonly actualMembers = [
    {
      requestedPath: 'opt/kata/bin/qemu-system-x86_64',
      path: 'opt/kata/bin/qemu-system-x86_64',
      size: 22835352,
      mode: 493,
      sha256: 'b94419fca709f2b928a20d7b04d856f87cdfdbc2db357872096f090cc2c58abc',
      links: [],
    },
    {
      requestedPath: 'opt/kata/libexec/virtiofsd',
      path: 'opt/kata/libexec/virtiofsd',
      size: 3303496,
      mode: 484,
      sha256: '15b2e72a78cc08a9bd8a6943e89fb69c88cb3cbeb63069efceade835342ac7d4',
      links: [],
    },
    {
      requestedPath: 'opt/kata/runtime-rs/bin/containerd-shim-kata-v2',
      path: 'opt/kata/runtime-rs/bin/containerd-shim-kata-v2',
      size: 48231984,
      mode: 493,
      sha256: '3c88c8d7f183b95912974eaa143f1c8a52c57b0a01c5ef4a4c61e22f16364481',
      links: [],
    },
    {
      requestedPath:
        'opt/kata/share/defaults/kata-containers/runtime-rs/configuration-qemu-runtime-rs.toml',
      path: 'opt/kata/share/defaults/kata-containers/runtime-rs/configuration-qemu-runtime-rs.toml',
      size: 35229,
      mode: 420,
      sha256: '870f8157d298a51784d3617854456edf16820bbc1e743b15467e441b63c43673',
      links: [],
    },
    {
      requestedPath: 'opt/kata/share/kata-containers/kata-containers.img',
      path: 'opt/kata/share/kata-containers/kata-ubuntu-noble.image',
      size: 268435456,
      mode: 420,
      sha256: '96497f64da1de9c7473fef46c3d29ddd0805d334731cf9d903a21a5b2c33cefb',
      links: [
        {
          path: 'opt/kata/share/kata-containers/kata-containers.img',
          target: 'opt/kata/share/kata-containers/kata-ubuntu-noble.image',
        },
      ],
    },
    {
      requestedPath: 'opt/kata/share/kata-containers/vmlinux.container',
      path: 'opt/kata/share/kata-containers/vmlinux-6.18.35-202',
      size: 40855000,
      mode: 420,
      sha256: '8e9dbc3a6e4c26adb089d23d31201edebce905c7f3e31aa67b32bdd41df1b86f',
      links: [
        {
          path: 'opt/kata/share/kata-containers/vmlinux.container',
          target: 'opt/kata/share/kata-containers/vmlinux-6.18.35-202',
        },
      ],
    },
  ];
  private async actual(custody: KitCustody): Promise<void> {
    const paths: string[] = [];
    for (const member of RuntimeKitMembersProgram.actualMembers) paths.push(member.requestedPath);
    const proof = await custody.inspect(paths, new AbortController().signal);
    assert.deepEqual(proof, {
      formatVersion: 1,
      archive: RuntimeKitFixture.actualIdentity,
      members: RuntimeKitMembersProgram.actualMembers,
    });
  }
  private async valid(custody: KitCustody, fixture: RuntimeKitFixture): Promise<void> {
    const paths = [RuntimeKitFixture.link, RuntimeKitFixture.file];
    const proof = await custody.inspect(paths, new AbortController().signal);
    this.proof(proof, fixture);
    const repeated = await custody.inspect(paths.reverse(), new AbortController().signal);
    assert.deepEqual(repeated, proof);
  }
  private members(proof: KitMembers): void {
    const common = {
      path: RuntimeKitFixture.file,
      size: RuntimeKitFixture.content.length,
      mode: 0o755,
      sha256: RuntimeKitFixture.digest(RuntimeKitFixture.content),
    };
    assert.deepEqual(proof.members, [
      { requestedPath: RuntimeKitFixture.file, ...common, links: [] },
      {
        requestedPath: RuntimeKitFixture.link,
        ...common,
        links: [{ path: RuntimeKitFixture.link, target: RuntimeKitFixture.file }],
      },
    ]);
  }
  private proof(proof: KitMembers, fixture: RuntimeKitFixture): void {
    assert.equal(proof.formatVersion, 1);
    assert.deepEqual(proof.archive, { sha256: fixture.input.sha256, size: fixture.input.size });
    this.members(proof);
    assert(
      Object.isFrozen(proof) && Object.isFrozen(proof.archive) && Object.isFrozen(proof.members),
    );
    for (const member of proof.members) {
      assert(Object.isFrozen(member) && Object.isFrozen(member.links));
      for (const link of member.links) assert(Object.isFrozen(link));
    }
  }
}
if (import.meta.main) await new RuntimeKitMembersProgram().run();

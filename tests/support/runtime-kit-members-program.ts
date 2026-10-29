import assert from 'node:assert/strict';
import { Header, type HeaderData } from 'tar';
import { zstdCompressSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { RuntimeArchiveCustody } from '@treeseed-cordis/deployment/sandbox';
export interface KitMembers {
  readonly formatVersion: number;
  readonly archive: { readonly sha256: string; readonly size: number };
  readonly members: readonly {
    readonly requestedPath: string;
    readonly path: string;
    readonly mode: number;
    readonly size: number;
    readonly sha256: string;
    readonly links: readonly { readonly path: string; readonly target: string }[];
  }[];
}
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
  constructor(mode = 'valid') {
    const bytes = this.bytes(mode);
    writeFileSync(this.path, bytes, { mode: 0o600 });
    this.input = { path: this.path, size: bytes.length, sha256: RuntimeKitFixture.digest(bytes) };
  }
  static digest(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
  }
  private bytes(mode: string): Buffer {
    const parts = this.members(mode);
    if (mode !== 'truncated') parts.push(Buffer.alloc(1024));
    const bytes = zstdCompressSync(Buffer.concat(parts));
    return mode === 'garbage' ? Buffer.concat([bytes, Buffer.from('PRIVATE_KIT_CANARY')]) : bytes;
  }
  private members(mode: string): Buffer[] {
    const parts = [
      this.entry({ path: RuntimeKitFixture.file, mode: 0o755 }, RuntimeKitFixture.content),
    ];
    const target =
      mode === 'escape' ? '../../../../outside' : mode === 'cycle' ? 'alias' : 'fixture';
    parts.push(
      this.entry({ path: RuntimeKitFixture.link, type: 'SymbolicLink', linkpath: target }),
    );
    parts.push(
      this.entry({ path: RuntimeKitFixture.alias, type: 'SymbolicLink', linkpath: 'selected' }),
    );
    if (mode === 'duplicate') parts.push(parts[0]!);
    if (mode === 'unsafe') parts.push(this.entry({ path: 'opt/kata/../outside' }));
    if (mode === 'special')
      parts.push(this.entry({ path: 'opt/kata/device', type: 'CharacterDevice' }));
    if (mode === 'permissions') parts.push(this.entry({ path: 'opt/kata/writable', mode: 0o666 }));
    if (mode === 'ancestor') parts.push(this.entry({ path: RuntimeKitFixture.link + '/child' }));
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
    const fixture = new RuntimeKitFixture(mode);
    const custody = await fixture.open();
    try {
      if (mode === 'garbage')
        await assert.rejects(
          custody.inspect([RuntimeKitFixture.link], new AbortController().signal),
          { code: 'KATA_RUNTIME_KIT_INVALID' },
        );
      else await this.valid(custody, fixture);
      custody.verify();
    } finally {
      custody.close();
      fixture.close();
    }
    process.stdout.write('runtime-kit-members-ok\n');
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

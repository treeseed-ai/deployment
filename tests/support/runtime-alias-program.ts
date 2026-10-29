import assert from 'node:assert/strict';
import { Header, type HeaderData } from 'tar';
import { zstdCompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  lstatSync,
  chmodSync,
  copyFileSync,
  lchownSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as Sandbox from '@treeseed-cordis/deployment/sandbox';
export interface AliasProof {
  kind: 'kata-installed-aliases';
  formatVersion: 1;
  archive: { sha256: string; size: number };
  installationRoot: string;
  bindings: readonly { role: string; member: string; path: string }[];
  aliases: readonly { path: string; target: string }[];
  digest: string;
}
export interface AliasCustody {
  readonly proof: AliasProof;
  verify(): void;
  close(): void;
}
interface AliasConstructor {
  open(
    components: Sandbox.RuntimeComponentCustody,
    root: string,
    signal: AbortSignal,
  ): Promise<AliasCustody>;
}
/** Genuine inert kit and installed link chain; no runtime, extraction or scripts. */
export class AliasFixture {
  readonly directory = realpathSync(mkdtempSync(join(tmpdir(), 'PRIVATE_RUNTIME_ALIAS_')));
  readonly root = join(this.directory, 'installed');
  readonly parent = join(this.root, 'opt/kata');
  readonly current = join(this.parent, 'current');
  readonly alias = join(this.parent, 'kernel');
  readonly terminal = join(this.parent, 'components/kernel.original');
  readonly bytes = Buffer.from('inert runtime alias component fixture\n');
  readonly signal = new AbortController().signal;
  readonly held: AliasCustody[] = [];
  archive: Sandbox.RuntimeArchiveCustody | null = null;
  components: Sandbox.RuntimeComponentCustody | null = null;
  constructor() {
    mkdirSync(join(this.parent, 'components'), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(this.terminal, this.bytes, { mode: 0o644 });
    chmodSync(this.terminal, 0o644);
    symlinkSync('components/kernel.original', this.alias);
    symlinkSync('kernel', this.current);
    writeFileSync(join(this.directory, 'kit.tar.zst'), zstdCompressSync(this.tar()), {
      mode: 0o600,
    });
  }
  private tar(): Buffer {
    return Buffer.concat([
      this.entry({ path: 'opt/kata/components/kernel.original' }, this.bytes),
      this.entry({
        path: 'opt/kata/kernel',
        type: 'SymbolicLink',
        linkpath: 'components/kernel.original',
        mode: 0o777,
      }),
      this.entry({
        path: 'opt/kata/current',
        type: 'SymbolicLink',
        linkpath: 'kernel',
        mode: 0o777,
      }),
      Buffer.alloc(1024),
    ]);
  }
  private entry(data: HeaderData, bytes = Buffer.alloc(0)): Buffer {
    const header = Buffer.alloc(512);
    new Header({
      type: 'File',
      mode: 0o644,
      size: bytes.length,
      ...data,
    }).encode(header);
    return Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
  }
  static type(): AliasConstructor {
    const value = Reflect.get(Sandbox, 'RuntimeAliasCustody') as AliasConstructor | undefined;
    assert(
      value && typeof value.open === 'function',
      'Public installed runtime alias custody missing',
    );
    return value;
  }
  async prepare(): Promise<void> {
    const path = join(this.directory, 'kit.tar.zst'),
      bytes = readFileSync(path);
    this.archive = await Sandbox.RuntimeArchiveCustody.open(
      {
        path,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      this.signal,
    );
    this.components = await Sandbox.RuntimeComponentCustody.open(
      this.archive,
      [{ role: 'kernel', member: 'opt/kata/current', path: this.terminal }],
      this.signal,
    );
  }
  async open(signal = this.signal, root = this.root): Promise<AliasCustody> {
    assert(this.components);
    const custody = await AliasFixture.type().open(this.components, root, signal);
    this.held.push(custody);
    return custody;
  }
  replace(target = 'PRIVATE_TARGET_CANARY'): void {
    rmSync(this.alias);
    symlinkSync(target, this.alias);
  }
  close(): void {
    try {
      for (const custody of this.held) custody.close();
    } finally {
      try {
        this.components?.close();
      } finally {
        this.archive?.close();
        rmSync(this.directory, { recursive: true, force: true });
      }
    }
  }
  static descriptors(): number {
    return readdirSync('/proc/self/fd').length;
  }
  descriptor(): number {
    for (const entry of readdirSync('/proc/self/fd')) {
      try {
        if (readlinkSync('/proc/self/fd/' + entry) === this.alias) return Number(entry);
      } catch {
        /* The proc directory's transient reader is already closed. */
      }
    }
    throw new Error('No retained alias descriptor');
  }
}
class RuntimeAliasProgram {
  static async run(): Promise<void> {
    const fixture = new AliasFixture();
    try {
      await fixture.prepare();
      const before = readdirSync(fixture.parent).sort();
      const first = await fixture.open();
      first.verify();
      assert.equal(first.proof.kind, 'kata-installed-aliases');
      assert.equal(first.proof.aliases.length, 2);
      assert(Object.isFrozen(first.proof) && Object.isFrozen(first.proof.aliases));
      assert.deepEqual((await fixture.open()).proof, first.proof);
      assert.deepEqual(readdirSync(fixture.parent).sort(), before);
      assert.deepEqual(readFileSync(fixture.terminal), fixture.bytes);
    } finally {
      fixture.close();
    }
    process.stdout.write('runtime-aliases-public-ok\n');
  }
  static async foreign(): Promise<void> {
    assert.equal(process.env.GITHUB_ACTIONS, 'true');
    assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
    assert.equal(process.getuid?.(), 0);
    const fixture = new AliasFixture();
    try {
      await fixture.prepare();
      lchownSync(fixture.alias, 65534, 65534);
      await assert.rejects(fixture.open.bind(fixture), {
        message: 'KATA_RUNTIME_ALIASES_INVALID',
      });
    } finally {
      fixture.close();
    }
    process.stdout.write('runtime-aliases-foreign-owner-ok\n');
  }
}
class UpstreamAliasProgram {
  private readonly directory = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-alias-upstream-')));
  private archive: Sandbox.RuntimeArchiveCustody | null = null;
  private components: Sandbox.RuntimeComponentCustody | null = null;
  private aliases: AliasCustody | null = null;
  static readonly members = [
    ['shim', 'opt/kata/runtime-rs/bin/containerd-shim-kata-v2'],
    ['hypervisor', 'opt/kata/bin/qemu-system-x86_64'],
    ['kernel', 'opt/kata/share/kata-containers/vmlinux.container'],
    ['rootfs', 'opt/kata/share/kata-containers/kata-containers.img'],
  ] as const;
  async run(source: string): Promise<void> {
    try {
      await this.retain(source);
      assert(this.aliases);
      this.aliases.verify();
      assert(this.aliases.proof.aliases.length > 0, 'Upstream alias proof must be genuine');
      assert.equal(this.aliases.proof.bindings.length, UpstreamAliasProgram.members.length);
    } finally {
      this.close();
    }
    process.stdout.write('runtime-aliases-upstream-ok\n');
  }
  private async retain(source: string): Promise<void> {
    const path = this.copy(source),
      signal = new AbortController().signal;
    this.archive = await Sandbox.RuntimeArchiveCustody.open(
      {
        path,
        size: 969565384,
        sha256: '3dc6b69c4acb787b967b04b64599a20d02a8beb1a8eaab3084110df9d0b08c96',
      },
      signal,
    );
    this.components = await Sandbox.RuntimeComponentCustody.open(
      this.archive,
      this.bindings(),
      signal,
    );
    this.aliases = await AliasFixture.type().open(this.components, '/', signal);
  }
  private copy(source: string): string {
    assert(lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink());
    const path = join(this.directory, 'kit.tar.zst');
    copyFileSync(source, path);
    chmodSync(path, 0o600);
    return path;
  }
  private bindings(): object[] {
    const result = [];
    for (const [role, member] of UpstreamAliasProgram.members)
      result.push({ role, member, path: realpathSync('/' + member) });
    return result;
  }
  private close(): void {
    try {
      this.aliases?.close();
    } finally {
      try {
        this.components?.close();
      } finally {
        this.archive?.close();
        rmSync(this.directory, { recursive: true, force: true });
      }
    }
  }
}
class AliasProgramEntry {
  static async run(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.length === 0) await RuntimeAliasProgram.run();
    else if (args.length === 1 && args[0] === '--foreign') await RuntimeAliasProgram.foreign();
    else if (args.length === 2 && args[0] === '--actual')
      await new UpstreamAliasProgram().run(args[1]!);
    else throw new Error('Invalid alias fixture arguments');
  }
}
if (import.meta.main) await AliasProgramEntry.run();

import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readlinkSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { CanonicalJson } from '@treeseed-cordis/sdk';
import { SafeDirectory } from './filesystem.js';
import { KataSandboxError } from './kata-command.js';
import { RuntimeComponentCustody, type RuntimeComponentBinding } from './runtime-components.js';
interface RuntimeAlias {
  readonly path: string;
  readonly target: string;
}
export interface RuntimeAliasProof {
  readonly kind: 'kata-installed-aliases';
  readonly formatVersion: 1;
  readonly archive: Readonly<{ sha256: string; size: number }>;
  readonly installationRoot: string;
  readonly bindings: readonly RuntimeComponentBinding[];
  readonly aliases: readonly RuntimeAlias[];
  readonly digest: string;
}
/** An anchor with stricter direct-parent permissions than shared ancestor traversal. */
export class RuntimeDirectoryAnchor {
  private closed = false;
  private readonly identity: Stats;
  private constructor(readonly directory: SafeDirectory) {
    this.identity = fstatSync(directory.fd);
  }
  static open(path: string): RuntimeDirectoryAnchor {
    const directory = SafeDirectory.open(path);
    try {
      const anchor = new RuntimeDirectoryAnchor(directory);
      anchor.verify();
      return anchor;
    } catch (error) {
      directory.close();
      throw error;
    }
  }
  verify(): void {
    this.directory.verify();
    const held = fstatSync(this.directory.fd),
      linked = lstatSync(this.directory.path);
    SafeDirectory.owner(held, false);
    if (
      !held.isDirectory() ||
      (held.mode & 0o022) !== 0 ||
      linked.isSymbolicLink() ||
      held.dev !== linked.dev ||
      held.ino !== linked.ino ||
      !this.same(held)
    )
      throw new Error();
  }
  private same(stat: Stats): boolean {
    const original = this.identity;
    return (
      stat.dev === original.dev &&
      stat.ino === original.ino &&
      stat.uid === original.uid &&
      stat.gid === original.gid &&
      stat.mode === original.mode &&
      stat.ctimeMs === original.ctimeMs &&
      stat.mtimeMs === original.mtimeMs
    );
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const held = fstatSync(this.directory.fd);
    if (!held.isDirectory() || held.dev !== this.identity.dev || held.ino !== this.identity.ino)
      throw new Error();
    this.directory.close();
  }
}
/** Linux O_PATH retains the link node; it never follows the declared target. */
class AliasDescriptor {
  private closed = false;
  private constructor(
    private readonly parent: RuntimeDirectoryAnchor,
    private readonly fd: number,
    private readonly selected: RuntimeAlias,
    private readonly identity: Stats,
  ) {}
  static open(selected: RuntimeAlias): AliasDescriptor {
    const parent = RuntimeDirectoryAnchor.open(dirname(selected.path));
    let fd = -1;
    try {
      fd = openSync(
        parent.directory.childPath(basename(selected.path)),
        0x200000 | 0x80000 | constants.O_NOFOLLOW,
      );
      const descriptor = new AliasDescriptor(parent, fd, selected, fstatSync(fd));
      descriptor.verify();
      return descriptor;
    } catch (error) {
      try {
        if (fd !== -1) closeSync(fd);
      } finally {
        parent.close();
      }
      throw error;
    }
  }
  private same(stat: Stats): boolean {
    const original = this.identity;
    return (
      stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      stat.dev === original.dev &&
      stat.ino === original.ino &&
      stat.uid === original.uid &&
      stat.gid === original.gid &&
      stat.mode === original.mode &&
      stat.size === original.size &&
      stat.mtimeMs === original.mtimeMs &&
      stat.ctimeMs === original.ctimeMs
    );
  }
  verify(): void {
    this.parent.verify();
    const path = this.parent.directory.childPath(basename(this.selected.path));
    const held = fstatSync(this.fd),
      before = lstatSync(path);
    if (held.uid !== 0 && held.uid !== process.getuid?.()) throw new Error();
    if (!this.same(held) || !this.same(before)) throw new Error();
    const target = resolve(dirname(this.selected.path), readlinkSync(path));
    if (target !== this.selected.target || !this.same(lstatSync(path))) throw new Error();
    this.parent.verify();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    let failed = false;
    try {
      this.releaseLink();
    } catch {
      failed = true;
    }
    try {
      this.parent.close();
    } catch {
      failed = true;
    }
    if (failed) throw new Error();
  }
  private releaseLink(): void {
    const held = fstatSync(this.fd);
    if (held.dev !== this.identity.dev || held.ino !== this.identity.ino || !held.isSymbolicLink())
      throw new Error();
    closeSync(this.fd);
  }
}
/** Borrows archive/component custody; owns only installed alias and directory descriptors. */
export class RuntimeAliasCustody {
  private readonly links: AliasDescriptor[] = [];
  private closed = false;
  private closeFailed = false;
  private constructor(
    private readonly components: RuntimeComponentCustody,
    private readonly root: RuntimeDirectoryAnchor,
    readonly proof: RuntimeAliasProof,
  ) {}
  static async open(
    components: RuntimeComponentCustody,
    installationRoot: string,
    signal: AbortSignal,
  ): Promise<RuntimeAliasCustody> {
    let custody: RuntimeAliasCustody | null = null;
    try {
      signal.throwIfAborted();
      const proof = this.projection(components, installationRoot);
      custody = new RuntimeAliasCustody(
        components,
        RuntimeDirectoryAnchor.open(installationRoot),
        proof,
      );
      await custody.capture(signal);
      return custody;
    } catch {
      try {
        custody?.close();
      } catch {}
      throw new KataSandboxError(
        signal.aborted ? 'KATA_CANCELLED' : 'KATA_RUNTIME_ALIASES_INVALID',
      );
    }
  }
  private static projection(components: RuntimeComponentCustody, root: string): RuntimeAliasProof {
    if (!(components instanceof RuntimeComponentCustody)) throw new Error();
    this.validateRoot(root);
    components.verify();
    const aliases = this.selections(components, root);
    const payload = Object.freeze({
      kind: 'kata-installed-aliases' as const,
      formatVersion: 1 as const,
      archive: components.proof.archive,
      installationRoot: root,
      bindings: components.bindings,
      aliases: Object.freeze(aliases),
    });
    return Object.freeze({ ...payload, digest: CanonicalJson.digest(payload) });
  }
  private static validateRoot(root: string): void {
    if (
      process.platform !== 'linux' ||
      process.arch !== 'x64' ||
      typeof root !== 'string' ||
      !root.startsWith('/') ||
      root.length > 4096 ||
      root.includes('\0') ||
      resolve(root) !== root
    )
      throw new Error();
  }
  private static selections(components: RuntimeComponentCustody, root: string): RuntimeAlias[] {
    const aliases = new Map<string, RuntimeAlias>();
    for (const binding of components.bindings) {
      const member = components.proof.components.find(this.role.bind(this, binding.role))?.member;
      if (!member || binding.path !== join(root, member.path)) throw new Error();
      for (const link of member.links) {
        const path = join(root, link.path),
          target = join(root, link.target);
        if (aliases.has(path) && aliases.get(path)!.target !== target) throw new Error();
        aliases.set(path, Object.freeze({ path, target }));
      }
    }
    return [...aliases.values()].sort(this.compare);
  }
  private static role(
    role: string,
    entry: RuntimeComponentCustody['proof']['components'][number],
  ): boolean {
    return entry.role === role;
  }
  private static compare(left: RuntimeAlias, right: RuntimeAlias): number {
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  }
  private async capture(signal: AbortSignal): Promise<void> {
    this.root.verify();
    for (const alias of this.proof.aliases) {
      signal.throwIfAborted();
      this.links.push(AliasDescriptor.open(alias));
    }
    await setImmediate();
    signal.throwIfAborted();
    this.verify();
  }
  verify(): void {
    KataSandboxError.require(!this.closed, 'KATA_RUNTIME_ALIASES_CLOSED');
    try {
      this.components.verify();
      this.root.verify();
      for (const link of this.links) link.verify();
      this.components.verify();
    } catch {
      throw new KataSandboxError('KATA_RUNTIME_ALIASES_CHANGED');
    }
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      for (const link of this.links) {
        try {
          link.close();
        } catch {
          this.closeFailed = true;
        }
      }
      try {
        this.root.close();
      } catch {
        this.closeFailed = true;
      }
    }
    KataSandboxError.require(!this.closeFailed, 'KATA_RUNTIME_ALIASES_CLOSE_FAILED');
  }
}

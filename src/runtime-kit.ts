import { Parser, type ReadEntry } from 'tar';
import { createHash, type Hash } from 'node:crypto';
import { createZstdDecompress } from 'node:zlib';
import { once } from 'node:events';
import { posix } from 'node:path';
import type { VerifiedDescriptor } from './filesystem.js';
import { KataSandboxError } from './kata-command.js';
export interface RuntimeKitMember {
  readonly requestedPath: string;
  readonly path: string;
  readonly size: number;
  readonly mode: number;
  readonly sha256: string;
  readonly links: readonly Readonly<{ path: string; target: string }>[];
}
export interface RuntimeKitMembers {
  readonly formatVersion: 1;
  readonly archive: Readonly<{ sha256: string; size: number }>;
  readonly members: readonly RuntimeKitMember[];
}
interface KitNode {
  path: string;
  type: string;
  size: number;
  mode: number;
  target?: string;
  sha256?: string;
}
interface KitFile {
  member: KitNode;
  hash: Hash;
  count: number;
}
/** A finite archive namespace; links are data and are never followed on the host. */
class KitMemberGraph {
  private readonly nodes = new Map<string, KitNode>();
  private declared = 0;
  static require(condition: unknown): asserts condition {
    KataSandboxError.require(condition, 'KATA_RUNTIME_KIT_INVALID');
  }
  static path(input: unknown): string {
    this.require(typeof input === 'string' && input.length > 0 && input.length <= 4096);
    this.require(/^[A-Za-z0-9._+/-]+$/.test(input));
    const parts = input.split('/');
    this.require(parts.length <= 64);
    for (const part of parts) this.require(part && part !== '.' && part !== '..');
    return input;
  }
  static selections(input: unknown): string[] {
    this.require(Array.isArray(input) && input.length > 0 && input.length <= 16);
    const paths: string[] = [];
    for (const item of input) {
      const path = this.path(item);
      this.require(path.startsWith('opt/kata/') && !paths.includes(path));
      paths.push(path);
    }
    return paths.sort();
  }
  add(entry: ReadEntry): KitFile | null {
    const path = this.name(entry);
    KitMemberGraph.require(!this.nodes.has(path) && this.nodes.size < 4096);
    const member = this.metadata(entry, path);
    this.nodes.set(path, member);
    if (member.type !== 'File') return null;
    this.declared += member.size;
    KitMemberGraph.require(this.declared <= 8 * 1024 ** 3);
    return { member, hash: createHash('sha256'), count: 0 };
  }
  private name(entry: ReadEntry): string {
    let name = entry.path.startsWith('./') ? entry.path.slice(2) : entry.path;
    if (entry.type === 'Directory' && name.endsWith('/')) name = name.slice(0, -1);
    if (['', 'opt', 'opt/kata'].includes(name)) {
      KitMemberGraph.require(entry.type === 'Directory');
      return name;
    }
    const path = KitMemberGraph.path(name);
    KitMemberGraph.require(path.startsWith('opt/kata/'));
    return path;
  }
  private metadata(entry: ReadEntry, path: string): KitNode {
    KitMemberGraph.require(['File', 'Directory', 'SymbolicLink'].includes(entry.type));
    KitMemberGraph.require(Number.isSafeInteger(entry.size) && entry.size >= 0);
    KitMemberGraph.require(
      Number.isInteger(entry.mode) && entry.mode! >= 0 && entry.mode! <= 0o777,
    );
    const member: KitNode = { path, type: entry.type, size: entry.size, mode: entry.mode! };
    if (entry.type === 'SymbolicLink') {
      const link = KitMemberGraph.path(entry.linkpath);
      member.target = posix.join(posix.dirname(path), link);
      KitMemberGraph.require(member.target.startsWith('opt/kata/') && entry.size === 0);
    } else {
      KitMemberGraph.require(!(member.mode & 0o022) && !!(member.mode & 0o400));
      if (entry.type === 'Directory') KitMemberGraph.require(entry.size === 0);
    }
    return member;
  }
  result(paths: string[]): readonly RuntimeKitMember[] {
    for (const node of this.nodes.values()) this.ancestors(node.path);
    const result: RuntimeKitMember[] = [];
    for (const path of paths) result.push(this.resolve(path));
    return Object.freeze(result);
  }
  private ancestors(path: string): void {
    let parent = posix.dirname(path);
    while (parent !== '.' && parent !== path) {
      const node = this.nodes.get(parent);
      KitMemberGraph.require(!node || node.type === 'Directory');
      path = parent;
      parent = posix.dirname(path);
    }
  }
  private resolve(requestedPath: string): RuntimeKitMember {
    const links: Readonly<{ path: string; target: string }>[] = [];
    const visited = new Set<string>();
    let path = requestedPath;
    for (;;) {
      KitMemberGraph.require(!visited.has(path));
      visited.add(path);
      const node = this.nodes.get(path);
      KitMemberGraph.require(node);
      if (node.type === 'File') return this.proof(requestedPath, node, links);
      KitMemberGraph.require(node.type === 'SymbolicLink' && node.target && links.length < 16);
      links.push(Object.freeze({ path, target: node.target }));
      path = node.target;
    }
  }
  private proof(
    requestedPath: string,
    node: KitNode,
    links: Readonly<{ path: string; target: string }>[],
  ): RuntimeKitMember {
    KitMemberGraph.require(typeof node.sha256 === 'string');
    return Object.freeze({
      requestedPath,
      path: node.path,
      size: node.size,
      mode: node.mode,
      sha256: node.sha256,
      links: Object.freeze(links),
    });
  }
}
/** Complete bounded streaming inspection over a duplicate of an already retained descriptor. */
export class RuntimeKitInspection {
  private readonly parser = new Parser({
    strict: true,
    gzip: false,
    zstd: false,
    brotli: false,
    maxMetaEntrySize: 65536,
  });
  private readonly graph = new KitMemberGraph();
  private readonly completion: Promise<unknown>;
  private problem = false;
  private eof = false;
  private decoded = 0;
  private observed = 0;
  constructor(private readonly compressedSize: number) {
    this.parser.on('entry', this.entry.bind(this));
    this.parser.on('error', this.failed.bind(this));
    this.parser.on('eof', this.footer.bind(this));
    this.completion = once(this.parser, 'end').catch(this.failed.bind(this));
  }
  static selections(input: unknown): string[] {
    return KitMemberGraph.selections(input);
  }
  async read(
    file: VerifiedDescriptor,
    paths: string[],
    signal: AbortSignal,
  ): Promise<readonly RuntimeKitMember[]> {
    const input = file.read(signal),
      decoder = createZstdDecompress();
    input.once('error', decoder.destroy.bind(decoder));
    input.pipe(decoder);
    try {
      for await (const chunk of decoder) {
        signal.throwIfAborted();
        if (!this.feed(Buffer.from(chunk))) await once(this.parser, 'drain', { signal });
      }
      await this.completed(decoder.bytesWritten, signal);
      return this.graph.result(paths);
    } finally {
      input.destroy();
      decoder.destroy();
    }
  }
  private async completed(consumed: number, signal: AbortSignal): Promise<void> {
    KitMemberGraph.require(consumed === this.compressedSize);
    this.parser.end();
    await this.completion;
    signal.throwIfAborted();
    KitMemberGraph.require(!this.problem && this.eof);
  }
  private feed(bytes: Buffer): boolean {
    this.decoded += bytes.length;
    KitMemberGraph.require(
      this.decoded <= Math.min(9 * 1024 ** 3, this.compressedSize * 64) && !this.problem,
    );
    const ready = this.parser.write(bytes);
    KitMemberGraph.require(!this.problem);
    return ready;
  }
  private entry(entry: ReadEntry): void {
    try {
      const file = this.graph.add(entry);
      if (file) {
        entry.on('data', this.data.bind(this, file));
        entry.on('end', this.finish.bind(this, file));
      }
      entry.resume();
    } catch {
      this.abort();
    }
  }
  private data(file: KitFile, bytes: Buffer): void {
    try {
      file.count += bytes.length;
      this.observed += bytes.length;
      KitMemberGraph.require(file.count <= file.member.size && this.observed <= 8 * 1024 ** 3);
      file.hash.update(bytes);
    } catch {
      this.abort();
    }
  }
  private finish(file: KitFile): void {
    try {
      KitMemberGraph.require(file.count === file.member.size);
      file.member.sha256 = file.hash.digest('hex');
    } catch {
      this.abort();
    }
  }
  private abort(): void {
    if (this.problem) return;
    this.problem = true;
    this.parser.abort(new KataSandboxError('KATA_RUNTIME_KIT_INVALID'));
  }
  private failed(): void {
    this.problem = true;
  }
  private footer(): void {
    this.eof = true;
  }
}

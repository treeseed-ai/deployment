import { z } from 'zod';
import { valid } from 'semver';
import { resolve } from 'node:path';
import { fstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Parser, type ReadEntry } from 'tar';
import {
  GuestRuntimeBinding,
  PlatformSchemas,
  type GuestRuntimeManifest,
} from '@treeseed-cordis/sdk';
import { SafeDirectory, StrictJson } from './filesystem.js';
import { ArchiveMetadata } from './artifacts.js';
import { GuestRuntimeElf } from './guest-elf.js';
import { KataSandboxError } from './kata-command.js';
export { GuestRuntimeElf } from './guest-elf.js';
export interface GuestRuntimeArtifact {
  manifest: GuestRuntimeManifest;
  executable: Buffer;
}
class GuestArchiveMembers {
  readonly files = new Map<string, Buffer>();
  private readonly parser: Parser;
  private chunks: Buffer[] = [];
  private current: ReadEntry | null = null;
  private size = 0;
  private accept: (() => void) | null = null;
  private reject: ((error: Error) => void) | null = null;
  constructor(private readonly archive: Buffer) {
    this.parser = new Parser({
      strict: true,
      maxMetaEntrySize: 1024 * 1024,
      maxDecompressionRatio: 1000,
      onReadEntry: this.entry.bind(this),
    });
  }
  read(): Promise<void> {
    return new Promise(this.start.bind(this));
  }
  private start(accept: () => void, reject: (error: Error) => void): void {
    this.accept = accept;
    this.reject = reject;
    this.parser.once('error', this.failed.bind(this));
    this.parser.once('end', this.end.bind(this));
    this.parser.end(this.archive);
  }
  private entry(entry: ReadEntry): void {
    if (!entry.path.startsWith('package/dist/bin/')) {
      entry.resume();
      return;
    }
    if (entry.type === 'Directory') {
      entry.resume();
      return;
    }
    if (entry.type !== 'File' || this.files.has(entry.path) || entry.size > 8 * 1024 * 1024)
      return this.parser.abort(new Error('KATA_GUEST_ARTIFACT_INVALID'));
    this.current = entry;
    this.chunks = [];
    this.size = 0;
    entry.on('data', this.data.bind(this));
    entry.once('end', this.memberEnd.bind(this));
  }
  private data(bytes: Buffer): void {
    this.size += bytes.length;
    if (this.size > this.current!.size)
      return this.parser.abort(new Error('KATA_GUEST_ARTIFACT_INVALID'));
    this.chunks.push(bytes);
  }
  private memberEnd(): void {
    const entry = this.current!;
    if (this.size !== entry.size)
      return this.parser.abort(new Error('KATA_GUEST_ARTIFACT_INVALID'));
    this.files.set(entry.path, Buffer.concat(this.chunks));
    this.current = null;
    this.chunks = [];
  }
  private end(): void {
    this.accept!();
  }
  private failed(): void {
    this.reject!(new KataSandboxError('KATA_GUEST_ARTIFACT_INVALID'));
  }
}
/** Read-only coherent admission invariant; accepted provider selection cannot bypass byte checks. */
export class GuestRuntimeArchive {
  static readonly configuration = z.strictObject({
    directory: PlatformSchemas.absolute,
    archive: PlatformSchemas.file.extend({
      size: z
        .number()
        .int()
        .min(1)
        .max(64 * 1024 * 1024),
    }),
    package: z.strictObject({ name: PlatformSchemas.packageName, version: PlatformSchemas.text }),
  });
  private readonly selected: z.infer<typeof GuestRuntimeArchive.configuration>;
  constructor(input: unknown) {
    const parsed = GuestRuntimeArchive.configuration.safeParse(input);
    KataSandboxError.require(parsed.success, 'KATA_GUEST_ARTIFACT_INVALID');
    KataSandboxError.require(
      SafeDirectory.segment(parsed.data.archive.path) &&
        valid(parsed.data.package.version) === parsed.data.package.version &&
        resolve(parsed.data.directory) === parsed.data.directory,
      'KATA_GUEST_ARTIFACT_INVALID',
    );
    this.selected = parsed.data;
  }
  async read(signal: AbortSignal): Promise<GuestRuntimeArtifact> {
    try {
      signal.throwIfAborted();
      const bytes = this.bytes();
      const reader = await this.index(bytes);
      const members = new GuestArchiveMembers(bytes);
      await members.read();
      signal.throwIfAborted();
      return this.admit(members.files, reader, signal);
    } catch {
      throw new KataSandboxError(signal.aborted ? 'KATA_CANCELLED' : 'KATA_GUEST_ARTIFACT_INVALID');
    }
  }
  private async index(bytes: Buffer): Promise<ArchiveMetadata> {
    const reader = new ArchiveMetadata(bytes, false, {
      bytes: 64 * 1024 * 1024,
      entries: 8192,
      files: 4096,
      file: 8 * 1024 * 1024,
    });
    const metadata = await reader.read();
    KataSandboxError.require(
      metadata.name === this.selected.package.name &&
        metadata.version === this.selected.package.version,
      'KATA_GUEST_ARTIFACT_INVALID',
    );
    return reader;
  }
  private bytes(): Buffer {
    const directory = SafeDirectory.open(this.selected.directory);
    try {
      SafeDirectory.owner(fstatSync(directory.fd), true);
      const archive = this.selected.archive;
      const bytes = directory.file(archive.path, archive.sha256, 64 * 1024 * 1024, true);
      KataSandboxError.require(bytes.length === archive.size, 'KATA_GUEST_ARTIFACT_INVALID');
      return bytes;
    } finally {
      directory.close();
    }
  }
  private admit(
    files: Map<string, Buffer>,
    index: ArchiveMetadata,
    signal: AbortSignal,
  ): GuestRuntimeArtifact {
    const manifestFile = 'package/dist/bin/guest-runtime.json';
    const json = files.get(manifestFile);
    KataSandboxError.require(json && json.length <= 65536, 'KATA_GUEST_ARTIFACT_INVALID');
    const manifest = GuestRuntimeBinding.assert(StrictJson.parse(json));
    const parts: Buffer[] = [];
    this.mode(index, manifestFile);
    for (const part of manifest.compressed.parts) {
      signal.throwIfAborted();
      const path = 'package/dist/bin/' + part.file;
      const bytes = files.get(path);
      this.identity(bytes, part);
      this.mode(index, path);
      parts.push(bytes!);
    }
    KataSandboxError.require(files.size === parts.length + 1, 'KATA_GUEST_ARTIFACT_INVALID');
    return { manifest, executable: this.expand(Buffer.concat(parts), manifest, signal) };
  }
  private mode(index: ArchiveMetadata, path: string): void {
    KataSandboxError.require(index.modes.get(path) === 0o644, 'KATA_GUEST_ARTIFACT_INVALID');
  }
  private identity(bytes: Buffer | undefined, expected: { size: number; sha256: string }): void {
    KataSandboxError.require(
      bytes && bytes.length === expected.size,
      'KATA_GUEST_ARTIFACT_INVALID',
    );
    KataSandboxError.require(
      createHash('sha256').update(bytes).digest('hex') === expected.sha256,
      'KATA_GUEST_ARTIFACT_INVALID',
    );
  }
  private expand(bytes: Buffer, manifest: GuestRuntimeManifest, signal: AbortSignal): Buffer {
    this.identity(bytes, manifest.compressed);
    signal.throwIfAborted();
    const executable = gunzipSync(bytes, { maxOutputLength: manifest.executable.size });
    this.identity(executable, manifest.executable);
    GuestRuntimeElf.verify(executable, manifest);
    signal.throwIfAborted();
    return executable;
  }
}

import { z } from 'zod';
import { fstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Parser, type ReadEntry } from 'tar';
import {
  CanonicalJson,
  PlatformSchemas,
  EnvironmentSchemas,
  type EnvironmentDefinition,
  type EnvironmentEntrypoint,
} from '@treeseed-cordis/sdk';
import { ArchiveMetadata } from './artifacts.js';
import { SafeDirectory, StrictJson } from './filesystem.js';
import { InstallationStore } from './installed.js';
import { KataSandboxError } from './kata-command.js';

export class KataWorkloadSchemas {
  static readonly environment = z.strictObject({
    ...EnvironmentSchemas.definition.shape,
    network: z.strictObject({
      mode: z.literal('offline'),
      destinations: z.array(z.never()).max(0),
    }),
  });
  static readonly configuration = z.strictObject({
    directory: PlatformSchemas.absolute,
    environments: z
      .array(
        z.strictObject({
          archive: PlatformSchemas.file.extend({
            size: z
              .number()
              .int()
              .min(1)
              .max(64 * 1024 * 1024),
          }),
          definition: this.environment,
        }),
      )
      .min(1)
      .max(128),
  });
  static readonly phase = z.enum(['setup', 'verification']);
  static readonly assignment = z.strictObject({
    sandboxId: PlatformSchemas.text,
    assignmentId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[a-zA-Z0-9:._-]+$/),
    environmentId: PlatformSchemas.text,
    environmentDigest: PlatformSchemas.digest,
    environmentRevision: PlatformSchemas.digest,
  });
  static readonly result = z.strictObject({
    sandboxId: PlatformSchemas.text,
    environmentId: PlatformSchemas.text,
    environmentRevision: PlatformSchemas.digest,
    phase: this.phase,
    entrypointDigest: PlatformSchemas.digest,
    networkDigest: PlatformSchemas.digest,
    inspectionDigest: PlatformSchemas.digest,
    exitCode: z.literal(0),
    outputBytes: z
      .number()
      .int()
      .min(0)
      .max(1024 * 1024),
  });
  static readonly record = z.strictObject({
    formatVersion: z.literal(1),
    contentDigest: PlatformSchemas.digest,
    configurationDigest: PlatformSchemas.digest,
    kind: z.enum(['assignment', 'intent', 'complete', 'failed']),
    sandboxId: PlatformSchemas.text,
    phase: this.phase.nullable(),
    digest: PlatformSchemas.digest,
    assignment: this.assignment.nullable(),
    result: this.result.nullable(),
  });
}
export type KataWorkloadConfiguration = z.infer<typeof KataWorkloadSchemas.configuration>;
export type KataAssignment = z.infer<typeof KataWorkloadSchemas.assignment>;
export type KataWorkloadResult = z.infer<typeof KataWorkloadSchemas.result>;
export type KataWorkloadPhase = z.infer<typeof KataWorkloadSchemas.phase>;
type WorkloadRecord = z.infer<typeof KataWorkloadSchemas.record>;
export interface KataPreparedEnvironment {
  definition: EnvironmentDefinition;
  setup: Buffer;
  verification: Buffer;
}

/** Verifies bytes without extracting files, importing code or invoking lifecycle scripts. */
export class KataEnvironmentArchive {
  private readonly configuration: KataWorkloadConfiguration;
  constructor(input: unknown) {
    const parsed = KataWorkloadSchemas.configuration.safeParse(input);
    KataSandboxError.require(parsed.success, 'KATA_ENVIRONMENT_INVALID');
    this.configuration = parsed.data;
    const ids = new Set<string>();
    for (const item of this.configuration.environments) {
      KataSandboxError.require(!ids.has(item.definition.id), 'KATA_ENVIRONMENT_DUPLICATE');
      KataSandboxError.require(SafeDirectory.segment(item.archive.path), 'KATA_ARCHIVE_PATH');
      KataSandboxError.require(
        EnvironmentSchemas.definition.safeParse(item.definition).success,
        'KATA_ENVIRONMENT_INVALID',
      );
      ids.add(item.definition.id);
    }
  }
  async read(id: string, image: string): Promise<KataPreparedEnvironment> {
    try {
      return await this.selected(id, image);
    } catch (error) {
      if (error instanceof KataSandboxError) throw error;
      throw new KataSandboxError('KATA_ENVIRONMENT_INVALID');
    }
  }
  private async selected(id: string, image: string): Promise<KataPreparedEnvironment> {
    const selected = this.selection(id, image);
    const bytes = this.bytes(selected.archive);
    const reader = new ArchiveMetadata(bytes, false, {
      bytes: 128 * 1024 * 1024,
      entries: 256,
      files: 256,
      file: 64 * 1024 * 1024,
    });
    const metadata = await reader.read();
    KataSandboxError.require(
      metadata.name === selected.definition.artifact.package &&
        metadata.version === selected.definition.artifact.version,
      'KATA_PACKAGE_IDENTITY',
    );
    for (const path of reader.paths)
      KataSandboxError.require(path.length <= 4096, 'KATA_ARCHIVE_PATH');
    const setup = await this.entry(bytes, reader, selected.definition.setup);
    const verification = await this.entry(bytes, reader, selected.definition.verification);
    return { definition: selected.definition, setup, verification };
  }
  private selection(id: string, image: string): KataWorkloadConfiguration['environments'][number] {
    for (const item of this.configuration.environments) {
      if (item.definition.id !== id) continue;
      KataSandboxError.require(
        item.definition.network.mode === 'offline',
        'KATA_NETWORK_UNQUALIFIED',
      );
      KataSandboxError.require(item.definition.image.reference === image, 'KATA_ENVIRONMENT_IMAGE');
      KataSandboxError.require(
        item.definition.artifact.integrity === item.archive.sha256,
        'KATA_ARCHIVE_IDENTITY',
      );
      return item;
    }
    throw new KataSandboxError('KATA_ENVIRONMENT_UNAVAILABLE');
  }
  private bytes(archive: { path: string; sha256: string; size: number }): Buffer {
    const directory = SafeDirectory.open(this.configuration.directory);
    try {
      SafeDirectory.owner(fstatSync(directory.fd), true);
      const bytes = directory.file(archive.path, archive.sha256, 64 * 1024 * 1024, true);
      KataSandboxError.require(bytes.length === archive.size, 'KATA_ARCHIVE_IDENTITY');
      return bytes;
    } finally {
      directory.close();
    }
  }
  private async entry(
    archive: Buffer,
    reader: ArchiveMetadata,
    entry: EnvironmentEntrypoint,
  ): Promise<Buffer> {
    const path = 'package/' + entry.file.path;
    const mode = reader.modes.get(path) ?? 0;
    KataSandboxError.require(
      reader.hashes.get(path) === entry.file.sha256 && reader.sizes.get(path) === entry.file.size,
      'KATA_ENTRYPOINT_IDENTITY',
    );
    KataSandboxError.require((mode & 0o111) !== 0 && (mode & 0o7022) === 0, 'KATA_ENTRYPOINT_MODE');
    return new KataArchiveMember(archive, path, entry.file).read();
  }
}

class KataArchiveMember {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private readonly parser: Parser;
  private accept: ((bytes: Buffer) => void) | null = null;
  private reject: ((error: Error) => void) | null = null;
  constructor(
    private readonly archive: Buffer,
    private readonly path: string,
    private readonly expected: { size: number; sha256: string },
  ) {
    this.parser = new Parser({
      strict: true,
      maxMetaEntrySize: 1024 * 1024,
      maxDecompressionRatio: 1000,
      onReadEntry: this.entry.bind(this),
    });
  }
  read(): Promise<Buffer> {
    return new Promise(this.start.bind(this));
  }
  private start(accept: (bytes: Buffer) => void, reject: (error: Error) => void): void {
    this.accept = accept;
    this.reject = reject;
    this.parser.once('error', this.failed.bind(this));
    this.parser.once('end', this.end.bind(this));
    this.parser.end(this.archive);
  }
  private entry(entry: ReadEntry): void {
    if (entry.path !== this.path) {
      entry.resume();
      return;
    }
    if (entry.type !== 'File' || entry.size !== this.expected.size) {
      this.parser.abort(new Error('KATA_ENTRYPOINT_IDENTITY'));
      return;
    }
    entry.on('data', this.data.bind(this));
  }
  private data(bytes: Buffer): void {
    this.bytes += bytes.length;
    if (this.bytes > this.expected.size) {
      this.parser.abort(new Error('KATA_ENTRYPOINT_IDENTITY'));
      return;
    }
    this.chunks.push(bytes);
  }
  private end(): void {
    const bytes = Buffer.concat(this.chunks);
    if (
      bytes.length !== this.expected.size ||
      createHash('sha256').update(bytes).digest('hex') !== this.expected.sha256
    )
      return this.failed();
    this.accept!(bytes);
  }
  private failed(): void {
    this.reject!(new KataSandboxError('KATA_ENTRYPOINT_IDENTITY'));
  }
}

/** Append-only phase intent and receipts beneath the already single-writer host custody. */
export class KataWorkloadJournal {
  private readonly scope: { formatVersion: 1; configurationDigest: string };
  constructor(
    private readonly directory: SafeDirectory,
    private readonly configurationDigest: string,
  ) {
    this.scope = { formatVersion: 1, configurationDigest };
    SafeDirectory.owner(fstatSync(directory.fd), true);
    KataSandboxError.require(directory.entries().length <= 10000, 'KATA_CUSTODY_LIMIT');
    for (const name of directory.entries()) this.validateExisting(name);
  }
  close(): void {
    this.directory.close();
  }
  private key(id: string, suffix: string): string {
    KataSandboxError.require(
      /^sandbox-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id),
      'KATA_SANDBOX_ID',
    );
    return CanonicalJson.digest({ id }) + '-' + suffix + '.json';
  }
  private read(name: string): WorkloadRecord | null {
    this.directory.verify();
    SafeDirectory.owner(fstatSync(this.directory.fd), true);
    if (!this.directory.entries().includes(name)) return null;
    const parsed = KataWorkloadSchemas.record.safeParse(
      StrictJson.parse(this.directory.file(name, undefined, 16384, true)),
    );
    KataSandboxError.require(
      parsed.success && parsed.data.configurationDigest === this.configurationDigest,
      'KATA_WORKLOAD_RECORD',
    );
    const { contentDigest, ...payload } = parsed.data;
    KataSandboxError.require(
      contentDigest === CanonicalJson.digest(payload),
      'KATA_WORKLOAD_RECORD',
    );
    return parsed.data;
  }
  private validateExisting(name: string): void {
    const record = this.read(name)!;
    const suffix = record.kind === 'assignment' ? 'assignment' : record.phase + '-' + record.kind;
    KataSandboxError.require(name === this.key(record.sandboxId, suffix), 'KATA_WORKLOAD_RECORD');
    if (record.kind === 'assignment') this.assignment(record.sandboxId);
    else {
      KataSandboxError.require(
        record.phase !== null && this.assignment(record.sandboxId) !== null,
        'KATA_WORKLOAD_RECORD',
      );
      if (record.kind === 'intent')
        KataSandboxError.require(
          this.terminal(record.sandboxId, record.phase) !== null,
          'KATA_REPAIR_REQUIRED',
        );
      else
        KataSandboxError.require(
          this.read(this.key(record.sandboxId, record.phase + '-intent'))?.digest === record.digest,
          'KATA_WORKLOAD_RECORD',
        );
    }
  }
  assignment(id: string): KataAssignment | null {
    const record = this.read(this.key(id, 'assignment'));
    if (!record) return null;
    KataSandboxError.require(
      record.kind === 'assignment' &&
        record.phase === null &&
        record.result === null &&
        record.assignment?.sandboxId === id &&
        CanonicalJson.digest(record.assignment) === record.digest,
      'KATA_WORKLOAD_RECORD',
    );
    return record.assignment;
  }
  assign(id: string, assignmentId: string, environment: EnvironmentDefinition): KataAssignment {
    const parsed = KataWorkloadSchemas.assignment.safeParse({
      sandboxId: id,
      assignmentId,
      environmentId: environment.id,
      environmentDigest: CanonicalJson.digest(environment),
      environmentRevision: environment.revision,
    });
    KataSandboxError.require(parsed.success, 'KATA_ASSIGNMENT_INVALID');
    const previous = this.assignment(id);
    if (previous) {
      KataSandboxError.require(
        CanonicalJson.stringify(previous) === CanonicalJson.stringify(parsed.data),
        'KATA_ALREADY_ASSIGNED',
      );
      return previous;
    }
    this.publish(id, 'assignment', null, CanonicalJson.digest(parsed.data), parsed.data, null);
    return this.assignment(id)!;
  }
  begin(id: string, phase: KataWorkloadPhase, digest: string): KataWorkloadResult | null {
    KataSandboxError.require(
      KataWorkloadSchemas.phase.safeParse(phase).success && this.assignment(id) !== null,
      'KATA_ASSIGNMENT_REQUIRED',
    );
    if (phase === 'verification')
      KataSandboxError.require(
        this.terminal(id, 'setup')?.kind === 'complete',
        'KATA_SETUP_REQUIRED',
      );
    const terminal = this.terminal(id, phase);
    if (terminal) {
      KataSandboxError.require(
        terminal.kind === 'complete' && terminal.digest === digest,
        'KATA_PHASE_FAILED',
      );
      return terminal.result;
    }
    KataSandboxError.require(!this.read(this.key(id, phase + '-intent')), 'KATA_REPAIR_REQUIRED');
    this.publish(id, 'intent', phase, digest, null, null);
    return null;
  }
  complete(
    id: string,
    phase: KataWorkloadPhase,
    digest: string,
    result: KataWorkloadResult,
  ): KataWorkloadResult {
    const parsed = KataWorkloadSchemas.result.safeParse(result);
    KataSandboxError.require(
      parsed.success && result.sandboxId === id && result.phase === phase,
      'KATA_WORKLOAD_RECORD',
    );
    const assignment = this.assignment(id);
    KataSandboxError.require(
      assignment &&
        result.environmentId === assignment.environmentId &&
        result.environmentRevision === assignment.environmentRevision,
      'KATA_WORKLOAD_RECORD',
    );
    this.finish(id, phase, digest, 'complete', parsed.data);
    return this.terminal(id, phase)!.result!;
  }
  failed(id: string, phase: KataWorkloadPhase, digest: string): void {
    this.finish(id, phase, digest, 'failed', null);
  }
  private finish(
    id: string,
    phase: KataWorkloadPhase,
    digest: string,
    kind: 'complete' | 'failed',
    result: KataWorkloadResult | null,
  ): void {
    KataSandboxError.require(
      this.read(this.key(id, phase + '-intent'))?.digest === digest &&
        this.terminal(id, phase) === null,
      'KATA_REPAIR_REQUIRED',
    );
    this.publish(id, kind, phase, digest, null, result);
  }
  private terminal(id: string, phase: KataWorkloadPhase): WorkloadRecord | null {
    const complete = this.read(this.key(id, phase + '-complete'));
    const failed = this.read(this.key(id, phase + '-failed'));
    KataSandboxError.require(!(complete && failed), 'KATA_WORKLOAD_RECORD');
    const record = complete ?? failed;
    if (record) this.validateTerminal(record, id, phase, complete !== null);
    return record;
  }
  private validateTerminal(
    record: WorkloadRecord,
    id: string,
    phase: KataWorkloadPhase,
    complete: boolean,
  ): void {
    KataSandboxError.require(
      record.sandboxId === id && record.phase === phase && record.assignment === null,
      'KATA_WORKLOAD_RECORD',
    );
    KataSandboxError.require(
      record.kind === (complete ? 'complete' : 'failed'),
      'KATA_WORKLOAD_RECORD',
    );
    KataSandboxError.require(
      this.read(this.key(id, phase + '-intent'))?.digest === record.digest,
      'KATA_WORKLOAD_RECORD',
    );
    if (!complete) {
      KataSandboxError.require(record.result === null, 'KATA_WORKLOAD_RECORD');
      return;
    }
    this.validateReceipt(record, id, phase);
  }
  private validateReceipt(record: WorkloadRecord, id: string, phase: KataWorkloadPhase): void {
    const assignment = this.assignment(id);
    const result = record.result;
    KataSandboxError.require(
      assignment &&
        result &&
        result.sandboxId === id &&
        result.phase === phase &&
        result.environmentId === assignment.environmentId &&
        result.environmentRevision === assignment.environmentRevision,
      'KATA_WORKLOAD_RECORD',
    );
  }
  private publish(
    id: string,
    kind: WorkloadRecord['kind'],
    phase: KataWorkloadPhase | null,
    digest: string,
    assignment: KataAssignment | null,
    result: KataWorkloadResult | null,
  ): void {
    const payload = {
      ...this.scope,
      kind,
      sandboxId: id,
      phase,
      digest,
      assignment,
      result,
    };
    const record = KataWorkloadSchemas.record.parse({
      ...payload,
      contentDigest: CanonicalJson.digest(payload),
    });
    const name = this.key(id, kind === 'assignment' ? kind : phase + '-' + kind);
    KataSandboxError.require(!this.read(name), 'KATA_REPAIR_REQUIRED');
    InstallationStore.publish(this.directory, name, record);
    KataSandboxError.require(
      CanonicalJson.stringify(this.read(name)) === CanonicalJson.stringify(record),
      'KATA_WORKLOAD_RECORD',
    );
  }
}

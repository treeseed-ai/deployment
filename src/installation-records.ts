import { z } from 'zod';
import { fstatSync, fsyncSync, rmdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CanonicalJson, PlatformSchemas, ServiceSchemas } from '@treeseed-cordis/sdk';
import { SafeDirectory, StrictJson, VerifiedDescriptor } from './filesystem.js';
import { InstallationStore } from './installed.js';
import { ServicePlanStore } from './service-plan.js';
type RecordCode =
  | 'INSTALLATION_RECORDS_INVALID'
  | 'INSTALLATION_RECORDS_BUSY'
  | 'INSTALLATION_RECORDS_CHANGED'
  | 'INSTALLATION_RECORDS_CANCELLED'
  | 'INSTALLATION_RECORDS_CLOSED'
  | 'INSTALLATION_RECORDS_WRITE_FAILED'
  | 'INSTALLATION_RECORDS_CLOSE_FAILED';
export class InstallationRecordError extends Error {
  constructor(readonly code: RecordCode) {
    super(code);
    this.name = 'InstallationRecordError';
  }
  static require(value: unknown, code: RecordCode = 'INSTALLATION_RECORDS_INVALID'): asserts value {
    if (!value) throw new InstallationRecordError(code);
  }
  static safe(error: unknown, signal?: AbortSignal): InstallationRecordError {
    if (error instanceof InstallationRecordError) return new InstallationRecordError(error.code);
    return new InstallationRecordError(
      signal?.aborted ? 'INSTALLATION_RECORDS_CANCELLED' : 'INSTALLATION_RECORDS_INVALID',
    );
  }
}
const Check: typeof InstallationRecordError = InstallationRecordError;
export interface InstallationRecord {
  readonly formatVersion: 1;
  readonly scopeDigest: string;
  readonly sequence: number;
  readonly previousDigest: string | null;
  readonly content: unknown;
  readonly digest: string;
}
/** Snapshot only JSON data; accessors, prototypes and cycles cannot become record behavior. */
class RecordValue {
  private readonly ancestors = new Set<object>();
  private count = 0;
  private bytes = 0;
  copy(value: unknown, depth = 0): unknown {
    Check.require(depth <= 64 && ++this.count <= 65536);
    if (typeof value === 'string') {
      this.budget(value);
      return value;
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      Check.require(Number.isFinite(value));
      return value;
    }
    Check.require(value && typeof value === 'object' && !this.ancestors.has(value));
    this.ancestors.add(value);
    try {
      return Array.isArray(value) ? this.array(value, depth) : this.object(value, depth);
    } finally {
      this.ancestors.delete(value);
    }
  }
  private budget(text: string): void {
    this.bytes += Buffer.byteLength(text);
    Check.require(this.bytes <= RecordEnvelope.maximum);
  }
  private array(value: unknown[], depth: number): readonly unknown[] {
    Check.require(Reflect.ownKeys(value).length === value.length + 1 && value.length <= 65536);
    const copied = [];
    for (let index = 0; index < value.length; index++)
      copied.push(this.copy(this.value(value, String(index)), depth + 1));
    return Object.freeze(copied);
  }
  private object(value: object, depth: number): Readonly<Record<string, unknown>> {
    Check.require(
      Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    );
    const copied: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      Check.require(
        typeof key === 'string' && !['__proto__', 'prototype', 'constructor'].includes(key),
      );
      this.budget(key);
      copied[key] = this.copy(this.value(value, key), depth + 1);
    }
    return Object.freeze(copied);
  }
  private value(object: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    Check.require(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
    return descriptor.value;
  }
}
class RecordEnvelope {
  static readonly maximum = 1024 * 1024;
  static readonly schema = z.strictObject({
    formatVersion: z.literal(1),
    scopeDigest: PlatformSchemas.digest,
    sequence: z.number().int().min(1).max(4096),
    previousDigest: PlatformSchemas.digest.nullable(),
    content: z.unknown(),
    digest: PlatformSchemas.digest,
  });
  static create(
    scopeDigest: string,
    sequence: number,
    previousDigest: string | null,
    content: unknown,
  ): InstallationRecord {
    const payload = { formatVersion: 1 as const, scopeDigest, sequence, previousDigest, content };
    const record = { ...payload, digest: CanonicalJson.digest(payload) };
    this.schema.parse(record);
    Check.require(this.bytes(record).length <= this.maximum);
    return Object.freeze(record);
  }
  static bytes(record: InstallationRecord): Buffer {
    return Buffer.from(CanonicalJson.stringify(record) + '\n');
  }
  static name(record: InstallationRecord): string {
    return String(record.sequence).padStart(8, '0') + '-' + record.digest + '.json';
  }
  static read(
    bytes: Buffer,
    name: string,
    scopeDigest: string,
    sequence: number,
    previous: string | null,
  ): InstallationRecord {
    Check.require(bytes.length <= this.maximum);
    const record = this.schema.parse(StrictJson.parse(bytes));
    Check.require(Object.hasOwn(record, 'content') && record.scopeDigest === scopeDigest);
    Check.require(record.sequence === sequence && record.previousDigest === previous);
    const expected = this.create(
      scopeDigest,
      sequence,
      previous,
      new RecordValue().copy(record.content),
    );
    Check.require(expected.digest === record.digest && this.name(expected) === name);
    Check.require(this.bytes(expected).equals(bytes));
    return expected;
  }
}
class RecordArea {
  static readonly Scope = z.strictObject({
    installationId: PlatformSchemas.text,
    installationDirectory: PlatformSchemas.absolute,
    namespace: PlatformSchemas.slot,
  });
  private readonly directories: SafeDirectory[] = [];
  private readonly files: VerifiedDescriptor[] = [];
  private writer: SafeDirectory | null = null;
  private owner: VerifiedDescriptor | null = null;
  private ownedWriter = false;
  private closed = false;
  private failedClose = false;
  directory!: SafeDirectory;
  scopeDigest = '';
  private constructor(readonly scope: z.infer<typeof RecordArea.Scope>) {}
  static open(input: unknown, create: boolean): RecordArea {
    const scope = this.Scope.parse(input);
    Check.require(resolve(scope.installationDirectory) === scope.installationDirectory);
    const area = new RecordArea(scope);
    try {
      area.establish(create);
      return area;
    } catch (error) {
      area.close(false);
      throw error;
    }
  }
  private retain(directory: SafeDirectory): SafeDirectory {
    this.directories.push(directory);
    return directory;
  }
  private pin(directory: SafeDirectory, name: string): VerifiedDescriptor {
    const file = VerifiedDescriptor.open(directory, name, true);
    this.files.push(file);
    return file;
  }
  private child(parent: SafeDirectory, name: string, create: boolean): SafeDirectory {
    parent.verify();
    if (parent.entries().includes(name)) return this.retain(parent.directory(name, true));
    Check.require(create);
    try {
      return this.retain(InstallationStore.mkdir(parent, name));
    } catch {
      throw new InstallationRecordError('INSTALLATION_RECORDS_WRITE_FAILED');
    }
  }
  private establish(create: boolean): void {
    const store = new ServicePlanStore(this.scope.installationDirectory);
    Check.require(store.inspect());
    const root = this.retain(SafeDirectory.open(this.scope.installationDirectory));
    Check.require(fstatSync(root.fd).uid === process.getuid?.());
    const state = this.child(root, '.cordis', false);
    const receiptDigest = this.receipt(state);
    const marker = this.markerBytes(receiptDigest);
    const artifacts = this.child(state, 'artifacts', create);
    const records = this.child(artifacts, 'records', create);
    const existed = records.entries().includes(this.scope.namespace);
    this.directory = this.child(records, this.scope.namespace, create);
    this.marker(marker, !existed && create);
    this.verify();
  }
  private receipt(state: SafeDirectory): string {
    const file = this.pin(state, 'installation.json');
    const bytes = state.file('installation.json', undefined, 4 * 1024 * 1024, true);
    const receipt = ServiceSchemas.receipt.parse(StrictJson.parse(bytes));
    Check.require(
      receipt.installationId === this.scope.installationId &&
        receipt.installationDirectory === this.scope.installationDirectory,
    );
    Check.require(receipt.ownerUid === process.getuid?.());
    file.verify();
    return createHash('sha256').update(bytes).digest('hex');
  }
  private markerBytes(receiptDigest: string): Buffer {
    const marker = { formatVersion: 1, ...this.scope, receiptDigest, ownerUid: process.getuid?.() };
    const bytes = Buffer.from(CanonicalJson.stringify(marker) + '\n');
    Check.require(bytes.length <= 4096);
    this.scopeDigest = createHash('sha256').update(bytes).digest('hex');
    return bytes;
  }
  private marker(bytes: Buffer, create: boolean): void {
    if (create) {
      try {
        InstallationStore.publish(this.directory, 'scope.json', bytes.toString(), 0o600, false);
      } catch {
        throw new InstallationRecordError('INSTALLATION_RECORDS_WRITE_FAILED');
      }
    }
    const file = this.pin(this.directory, 'scope.json');
    Check.require(this.directory.file('scope.json', this.scopeDigest, 4096, true).equals(bytes));
    file.verify();
  }
  acquire(): void {
    this.verify();
    Check.require(!this.directory.entries().includes('writer.lock'), 'INSTALLATION_RECORDS_BUSY');
    try {
      this.writer = this.retain(InstallationStore.mkdir(this.directory, 'writer.lock'));
      this.owner = this.writerIdentity(this.writer);
      this.ownedWriter = true;
      this.verify();
    } catch {
      throw new InstallationRecordError('INSTALLATION_RECORDS_WRITE_FAILED');
    }
  }
  private writerIdentity(writer: SafeDirectory): VerifiedDescriptor {
    InstallationStore.publish(
      writer,
      'owner.json',
      {
        formatVersion: 1,
        scopeDigest: this.scopeDigest,
        pid: process.pid,
        ownerUid: process.getuid?.(),
        nonce: randomUUID(),
      },
      0o600,
      false,
    );
    return this.pin(writer, 'owner.json');
  }
  verify(): void {
    Check.require(!this.closed, 'INSTALLATION_RECORDS_CLOSED');
    try {
      for (const [index, directory] of this.directories.entries()) {
        directory.verify();
        if (index > 0) Check.require((fstatSync(directory.fd).mode & 0o777) === 0o700);
      }
      for (const file of this.files) file.verify();
      if (this.ownedWriter) {
        Check.require(this.writer?.entries().join(',') === 'owner.json');
        this.owner!.verify();
      } else
        Check.require(
          !this.directory.entries().includes('writer.lock'),
          'INSTALLATION_RECORDS_BUSY',
        );
    } catch (error) {
      if (error instanceof InstallationRecordError && error.code === 'INSTALLATION_RECORDS_BUSY')
        throw error;
      throw new InstallationRecordError('INSTALLATION_RECORDS_CHANGED');
    }
  }
  names(): string[] {
    this.verify();
    const names: string[] = [];
    for (const name of this.directory.entries()) {
      if (name === 'scope.json' || (this.ownedWriter && name === 'writer.lock')) continue;
      Check.require(/^[0-9]{8}-[a-f0-9]{64}\.json$/.test(name));
      names.push(name);
    }
    Check.require(names.length <= 4096);
    return names.sort();
  }
  publish(record: InstallationRecord): void {
    this.verify();
    Check.require(this.ownedWriter);
    InstallationStore.publish(
      this.directory,
      RecordEnvelope.name(record),
      RecordEnvelope.bytes(record).toString(),
      0o600,
      false,
    );
    this.verify();
  }
  private release(): void {
    this.verify();
    Check.require(this.writer && this.owner && this.ownedWriter);
    unlinkSync(this.writer.childPath('owner.json'));
    rmdirSync(this.directory.childPath('writer.lock'));
    fsyncSync(this.directory.fd);
    this.ownedWriter = false;
  }
  close(release = true): void {
    if (!this.closed) {
      if (release && this.ownedWriter) {
        try {
          this.release();
        } catch {
          this.failedClose = true;
        }
      }
      this.closed = true;
      this.closeHandles();
    }
    Check.require(!this.failedClose, 'INSTALLATION_RECORDS_CLOSE_FAILED');
  }
  private closeHandles(): void {
    for (const file of [...this.files].reverse()) {
      try {
        file.close();
      } catch {
        this.failedClose = true;
      }
    }
    for (const directory of [...this.directories].reverse()) {
      try {
        directory.close();
      } catch {
        this.failedClose = true;
      }
    }
  }
}
class RecordChain {
  private readonly files: VerifiedDescriptor[] = [];
  private bytes = 0;
  private static turn(done: (value: void) => void): void {
    setImmediate(done);
  }
  async read(area: RecordArea, signal: AbortSignal): Promise<readonly InstallationRecord[]> {
    const records: InstallationRecord[] = [];
    try {
      await new Promise<void>(RecordChain.turn);
      signal.throwIfAborted();
      const names = area.names();
      for (const name of names) {
        signal.throwIfAborted();
        records.push(this.record(area, name, records));
        await new Promise<void>(RecordChain.turn);
      }
      signal.throwIfAborted();
      area.verify();
      Check.require(area.names().join(',') === names.join(','), 'INSTALLATION_RECORDS_CHANGED');
      for (const file of this.files) file.verify();
      return Object.freeze(records);
    } finally {
      this.close();
    }
  }
  private record(
    area: RecordArea,
    name: string,
    previous: InstallationRecord[],
  ): InstallationRecord {
    const file = VerifiedDescriptor.open(area.directory, name, true);
    this.files.push(file);
    const size = file.metadata().size;
    this.bytes += size;
    Check.require(size <= RecordEnvelope.maximum && this.bytes <= 64 * 1024 * 1024);
    const bytes = area.directory.file(name, undefined, RecordEnvelope.maximum, true);
    const record = RecordEnvelope.read(
      bytes,
      name,
      area.scopeDigest,
      previous.length + 1,
      previous.at(-1)?.digest ?? null,
    );
    file.verify();
    return record;
  }
  private close(): void {
    let failed = false;
    for (const file of this.files) {
      try {
        file.close();
      } catch {
        failed = true;
      }
    }
    Check.require(!failed, 'INSTALLATION_RECORDS_CLOSE_FAILED');
  }
}
/** One namespace writer; seed/domain meaning remains with the consuming owner. */
export class InstallationRecords {
  private busy = false;
  private closed = false;
  private failedClose = false;
  private faulted = false;
  private publicationFailed = false;
  private constructor(
    private readonly area: RecordArea,
    private readonly signal: AbortSignal,
    private snapshot: readonly InstallationRecord[],
  ) {}
  static async acquire(scope: unknown, signal: AbortSignal): Promise<InstallationRecords> {
    let area: RecordArea | null = null;
    try {
      signal.throwIfAborted();
      area = RecordArea.open(scope, true);
      area.acquire();
      const records = await new RecordChain().read(area, signal);
      return new InstallationRecords(area, signal, records);
    } catch (error) {
      area?.close();
      throw Check.safe(error, signal);
    }
  }
  static async inspect(
    scope: unknown,
    signal: AbortSignal,
  ): Promise<readonly InstallationRecord[]> {
    let area: RecordArea | null = null;
    try {
      signal.throwIfAborted();
      area = RecordArea.open(scope, false);
      return await new RecordChain().read(area, signal);
    } catch (error) {
      throw Check.safe(error, signal);
    } finally {
      area?.close(false);
    }
  }
  private admit(): void {
    Check.require(!this.closed, 'INSTALLATION_RECORDS_CLOSED');
    Check.require(!this.busy, 'INSTALLATION_RECORDS_BUSY');
    Check.require(!this.faulted, 'INSTALLATION_RECORDS_CHANGED');
    if (this.signal.aborted) throw new InstallationRecordError('INSTALLATION_RECORDS_CANCELLED');
  }
  private same(records: readonly InstallationRecord[]): void {
    Check.require(records.length === this.snapshot.length, 'INSTALLATION_RECORDS_CHANGED');
    for (const [index, record] of records.entries())
      Check.require(record.digest === this.snapshot[index]!.digest, 'INSTALLATION_RECORDS_CHANGED');
  }
  async read(): Promise<readonly InstallationRecord[]> {
    this.admit();
    this.busy = true;
    try {
      const records = await new RecordChain().read(this.area, this.signal);
      this.same(records);
      return records;
    } catch (error) {
      this.faulted = true;
      throw Check.safe(error, this.signal);
    } finally {
      this.busy = false;
    }
  }
  async append(expectedHead: string | null, input: unknown): Promise<InstallationRecord> {
    this.admit();
    this.busy = true;
    try {
      const content = new RecordValue().copy(input);
      const record = await this.prepare(expectedHead, content);
      return await this.publish(record);
    } catch (error) {
      throw Check.safe(error, this.signal);
    } finally {
      this.busy = false;
    }
  }
  private async prepare(
    expectedHead: string | null,
    content: unknown,
  ): Promise<InstallationRecord> {
    const records = await new RecordChain().read(this.area, this.signal);
    this.same(records);
    Check.require(
      expectedHead === (records.at(-1)?.digest ?? null),
      'INSTALLATION_RECORDS_CHANGED',
    );
    return RecordEnvelope.create(this.area.scopeDigest, records.length + 1, expectedHead, content);
  }
  private async publish(record: InstallationRecord): Promise<InstallationRecord> {
    try {
      this.area.publish(record);
      const saved = await new RecordChain().read(this.area, this.signal);
      Check.require(saved.length === record.sequence && saved.at(-1)?.digest === record.digest);
      this.snapshot = saved;
      return saved.at(-1)!;
    } catch {
      this.faulted = true;
      this.publicationFailed = true;
      throw new InstallationRecordError('INSTALLATION_RECORDS_WRITE_FAILED');
    }
  }
  close(): void {
    Check.require(!this.busy, 'INSTALLATION_RECORDS_BUSY');
    if (!this.closed) {
      this.closed = true;
      try {
        this.area.close(!this.publicationFailed);
      } catch {
        this.failedClose = true;
      }
      this.failedClose ||= this.publicationFailed;
    }
    Check.require(!this.failedClose, 'INSTALLATION_RECORDS_CLOSE_FAILED');
  }
}

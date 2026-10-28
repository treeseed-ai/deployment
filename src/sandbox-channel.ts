import { z } from 'zod';
import { createServer, Socket, type Server } from 'node:net';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  lstatSync,
  chmodSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Library } from 'bun:ffi';
import {
  CanonicalJson,
  PlatformSchemas,
  ProviderV4Schemas,
  CapabilityToken,
  SandboxControlSchemas,
  SandboxControlBinding,
  SandboxControlError,
  type SandboxControlScope,
  type SandboxControlGrant,
  type SandboxControlRequest,
  type SandboxControlResponse,
  type SandboxControlClient,
  type SandboxControlCode,
  type SandboxAvailability,
  type SandboxEvidence,
  type SandboxAssignment,
  type SandboxPhaseReceipt,
  type SandboxDestructionReceipt,
} from '@treeseed-cordis/sdk';
import {
  Context,
  CordisScope,
  CordisServiceLocator,
  type ProviderLease,
  type ProviderRegistration,
} from '@treeseed-cordis/sdk/runtime';
import { SafeDirectory, StrictJson } from './filesystem.js';
import {
  KataSandboxPlugin,
  KataSandboxToken,
  type KataBackendConfiguration,
  type KataSandboxHost,
} from './kata-backend.js';

class ControlGuard {
  static require(value: unknown, code: SandboxControlCode): asserts value {
    if (!value) throw new SandboxControlError(code);
  }
  static failure(error: unknown): SandboxControlCode {
    if (
      error instanceof SandboxControlError &&
      SandboxControlSchemas.code.safeParse(error.code).success
    )
      return error.code;
    return 'SANDBOX_OPERATION_FAILED';
  }
}
class ControlSchemas {
  static readonly pin = z.strictObject({
    path: PlatformSchemas.absolute,
    sha256: PlatformSchemas.digest,
  });
  static readonly client = z.strictObject({
    endpointDirectory: PlatformSchemas.absolute,
    authorityFile: PlatformSchemas.absolute,
    scope: SandboxControlSchemas.scope,
    timeoutMs: z.number().int().min(50).max(86400000).default(120000),
  });
  static readonly authority = z.strictObject({
    credential: z.string().regex(/^[a-f0-9]{64}$/),
    grant: SandboxControlSchemas.grant,
  });
  static readonly frame = z.strictObject({
    credential: this.authority.shape.credential,
    request: SandboxControlSchemas.request,
  });
  static parse<T>(schema: z.ZodType<T>, input: unknown): T {
    const parsed = schema.safeParse(input);
    ControlGuard.require(parsed.success, 'INVALID_SANDBOX_CONTROL_CONTRACT');
    return parsed.data;
  }
}
type ControlAuthorityRecord = z.infer<typeof ControlSchemas.authority>;
interface SocketFactory {
  bind(directory: SafeDirectory): Promise<number>;
  close(): void;
}
class ControlMethods<T extends object> {
  constructor(private readonly methods: string[]) {}
  parse(input: unknown): T {
    ControlGuard.require(input && typeof input === 'object', 'SANDBOX_PROVIDER_UNAVAILABLE');
    for (const name of this.methods)
      ControlGuard.require(
        typeof Reflect.get(input, name) === 'function',
        'SANDBOX_PROVIDER_UNAVAILABLE',
      );
    return input as T;
  }
}
export const UnixSocketToken = new CapabilityToken<SocketFactory>(
  'host.socket.unix',
  ProviderV4Schemas.version,
  new ControlMethods(['bind', 'close']),
);

/** Privileged native IO resource; never exposed through the worker protocol. */
export class UnixSocketPlugin implements SocketFactory {
  static readonly provide = ['host.socket.unix'];
  static readonly inject: string[] = [];
  static readonly Config = ControlSchemas.pin;
  static readonly declaration = ProviderV4Schemas.declaration.parse({
    id: 'deployment.socket.unix',
    pluginId: 'deployment',
    capability: this.provide[0],
    contractVersion: ProviderV4Schemas.version,
    target: 'deployment',
    provide: this.provide,
    inject: this.inject,
  });
  static readonly symbols = {
    socket: { args: ['int', 'int', 'int'], returns: 'int' },
    bind: { args: ['int', 'ptr', 'uint32_t'], returns: 'int' },
    listen: { args: ['int', 'int'], returns: 'int' },
    close: { args: ['int'], returns: 'int' },
  } as const;
  private library: Library<typeof UnixSocketPlugin.symbols> | null = null;
  private closing = false;
  private requested = false;
  constructor(
    context: Context,
    private readonly configuration: z.infer<typeof ControlSchemas.pin>,
  ) {
    context.provide('host.socket.unix', this);
    context.effect(this.effect.bind(this));
  }
  private effect(): () => void {
    return this.close.bind(this);
  }
  private descriptor(): number {
    const directory = SafeDirectory.open(dirname(this.configuration.path));
    try {
      const fd = openSync(
        directory.childPath(basename(this.configuration.path)),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        this.verifyLibrary(fd);
        directory.verify();
        return fd;
      } catch (error) {
        closeSync(fd);
        throw error;
      }
    } finally {
      directory.close();
    }
  }
  private verifyLibrary(fd: number): void {
    const stat = fstatSync(fd);
    ControlGuard.require(
      stat.isFile() &&
        stat.uid === 0 &&
        stat.nlink === 1 &&
        (stat.mode & 0o022) === 0 &&
        stat.size <= 64 * 1024 * 1024,
      'SANDBOX_PROVIDER_UNAVAILABLE',
    );
    const bytes = this.libraryBytes(fd, stat.size);
    ControlGuard.require(
      bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) &&
        createHash('sha256').update(bytes).digest('hex') === this.configuration.sha256,
      'SANDBOX_PROVIDER_UNAVAILABLE',
    );
  }
  private libraryBytes(fd: number, size: number): Buffer {
    const before = fstatSync(fd);
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, bytes, offset, size - offset, offset);
      ControlGuard.require(count > 0, 'SANDBOX_PROVIDER_UNAVAILABLE');
      offset += count;
    }
    const after = fstatSync(fd);
    ControlGuard.require(
      before.size === size &&
        after.size === size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs,
      'SANDBOX_PROVIDER_UNAVAILABLE',
    );
    return bytes;
  }
  private async loaded(): Promise<Library<typeof UnixSocketPlugin.symbols>> {
    ControlGuard.require(
      !this.closing &&
        process.platform === 'linux' &&
        process.arch === 'x64' &&
        typeof Bun !== 'undefined',
      'SANDBOX_PROVIDER_UNAVAILABLE',
    );
    if (this.library) return this.library;
    const fd = this.descriptor();
    try {
      return await this.loadPinned(fd);
    } finally {
      closeSync(fd);
    }
  }
  private async loadPinned(fd: number): Promise<Library<typeof UnixSocketPlugin.symbols>> {
    const native = await import('bun:ffi');
    ControlGuard.require(!this.closing, 'SANDBOX_PROVIDER_UNAVAILABLE');
    const library = native.dlopen('/proc/self/fd/' + fd, UnixSocketPlugin.symbols);
    try {
      this.verifyLibrary(fd);
      this.library = library;
      return library;
    } catch (error) {
      library.close();
      throw error;
    }
  }
  async bind(directory: SafeDirectory): Promise<number> {
    try {
      ControlGuard.require(!this.requested && !this.closing, 'SANDBOX_PROVIDER_UNAVAILABLE');
      this.requested = true;
      directory.verify();
      SafeDirectory.owner(fstatSync(directory.fd), true);
      ControlGuard.require(directory.entries().length === 0, 'SANDBOX_REPAIR_REQUIRED');
      const library = await this.loaded();
      return await this.allocate(directory, library);
    } catch (error) {
      throw new SandboxControlError(ControlGuard.failure(error));
    }
  }
  private async allocate(
    directory: SafeDirectory,
    library: Library<typeof UnixSocketPlugin.symbols>,
  ): Promise<number> {
    const native = await import('bun:ffi');
    ControlGuard.require(!this.closing && this.library === library, 'SANDBOX_PROVIDER_UNAVAILABLE');
    const fd = library.symbols.socket(1, 1 | 0x80000 | 0x800, 0);
    ControlGuard.require(fd >= 0, 'SANDBOX_OPERATION_FAILED');
    try {
      this.bound(directory, fd, library, native.ptr);
      return fd;
    } catch (error) {
      library.symbols.close(fd);
      throw error;
    }
  }
  private bound(
    directory: SafeDirectory,
    fd: number,
    library: Library<typeof UnixSocketPlugin.symbols>,
    pointer: typeof import('bun:ffi').ptr,
  ): void {
    const path = directory.childPath('control.sock');
    ControlGuard.require(
      Buffer.byteLength(join(directory.path, 'control.sock')) <= 103,
      'INVALID_SANDBOX_CONTROL_CONTRACT',
    );
    const address = Buffer.alloc(110);
    address.writeUInt16LE(1, 0);
    address.write(path, 2);
    ControlGuard.require(
      library.symbols.bind(fd, pointer(address), address.length) === 0,
      'SANDBOX_OPERATION_FAILED',
    );
    chmodSync(path, 0o600);
    ControlGuard.require(library.symbols.listen(fd, 16) === 0, 'SANDBOX_OPERATION_FAILED');
    directory.verify();
  }
  close(): void {
    this.closing = true;
    this.library?.close();
    this.library = null;
  }
}

class ControlAuthority {
  constructor(
    private readonly path: string,
    private readonly scope: SandboxControlScope,
  ) {}
  read(): ControlAuthorityRecord {
    const directory = SafeDirectory.open(dirname(this.path));
    try {
      SafeDirectory.owner(fstatSync(directory.fd), true);
      const bytes = directory.file(basename(this.path), undefined, 65536, true);
      const record = ControlSchemas.parse(ControlSchemas.authority, StrictJson.parse(bytes));
      ControlGuard.require(
        CanonicalJson.stringify(record.grant.scope) === CanonicalJson.stringify(this.scope),
        'SANDBOX_SCOPE_MISMATCH',
      );
      return record;
    } catch (error) {
      if (error instanceof SandboxControlError) throw error;
      throw new SandboxControlError('SANDBOX_OPERATION_FAILED');
    } finally {
      directory.close();
    }
  }
  verify(record: ControlAuthorityRecord): void {
    ControlGuard.require(
      CanonicalJson.stringify(this.read()) === CanonicalJson.stringify(record),
      'SANDBOX_GRANT_REVOKED',
    );
  }
  authenticate(credential: string, record: ControlAuthorityRecord): void {
    ControlGuard.require(/^[a-f0-9]{64}$/.test(credential), 'SANDBOX_OPERATION_DENIED');
    ControlGuard.require(
      timingSafeEqual(Buffer.from(credential, 'hex'), Buffer.from(record.credential, 'hex')),
      'SANDBOX_OPERATION_DENIED',
    );
  }
}
class ControlSocketIdentity {
  static read(directory: SafeDirectory): Stats {
    directory.verify();
    SafeDirectory.owner(fstatSync(directory.fd), true);
    const stat = lstatSync(directory.childPath('control.sock'));
    ControlGuard.require(
      stat.isSocket() &&
        !stat.isSymbolicLink() &&
        stat.nlink === 1 &&
        stat.uid === process.getuid?.() &&
        (stat.mode & 0o777) === 0o600,
      'SANDBOX_RESOURCE_CHANGED',
    );
    return stat;
  }
  static verify(directory: SafeDirectory, expected: Stats): void {
    const actual = this.read(directory);
    ControlGuard.require(
      actual.dev === expected.dev &&
        actual.ino === expected.ino &&
        actual.ctimeMs === expected.ctimeMs,
      'SANDBOX_RESOURCE_CHANGED',
    );
  }
}
class ControlExchange {
  private readonly identity: Stats;
  private readonly socket = new Socket();
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private done = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private accept: ((response: SandboxControlResponse) => void) | null = null;
  private reject: ((error: Error) => void) | null = null;
  private readonly cancellation: () => void;
  constructor(
    private readonly directory: SafeDirectory,
    private readonly request: SandboxControlRequest,
    private readonly authority: ControlAuthority,
    private readonly record: ControlAuthorityRecord,
    private readonly signal: AbortSignal,
    private readonly timeoutMs: number,
  ) {
    this.identity = ControlSocketIdentity.read(directory);
    this.cancellation = this.cancel.bind(this);
  }
  run(): Promise<SandboxControlResponse> {
    return new Promise(this.start.bind(this));
  }
  private start(
    accept: (response: SandboxControlResponse) => void,
    reject: (error: Error) => void,
  ): void {
    this.accept = accept;
    this.reject = reject;
    if (this.signal.aborted) return this.cancel();
    this.timer = setTimeout(
      this.failed.bind(this),
      Math.min(this.timeoutMs, this.record.grant.expiresAtEpochMs - Date.now()),
    );
    this.signal.addEventListener('abort', this.cancellation, { once: true });
    this.socket.once('error', this.failed.bind(this));
    this.socket.on('data', this.data.bind(this));
    this.socket.once('end', this.end.bind(this));
    this.socket.once('close', this.closed.bind(this));
    this.socket.connect(this.directory.childPath('control.sock'), this.connected.bind(this));
  }
  private connected(): void {
    try {
      ControlSocketIdentity.verify(this.directory, this.identity);
      this.authority.verify(this.record);
      SandboxControlBinding.assertRequest(this.request, this.record.grant, Date.now());
      this.socket.write(
        CanonicalJson.stringify({ credential: this.record.credential, request: this.request }) +
          '\n',
      );
    } catch (error) {
      this.fail(ControlGuard.failure(error));
    }
  }
  private data(bytes: Buffer): void {
    if (this.done) return;
    this.bytes += bytes.length;
    if (this.bytes > 65536) return this.failed();
    this.chunks.push(bytes);
  }
  private end(): void {
    if (this.done) return;
    try {
      const bytes = Buffer.concat(this.chunks);
      ControlGuard.require(
        bytes.length > 0 && bytes.indexOf(10) === bytes.length - 1,
        'SANDBOX_RESPONSE_MISMATCH',
      );
      const response = SandboxControlBinding.assertResponse(
        StrictJson.parse(bytes.subarray(0, -1)),
        this.request,
      );
      this.validate();
      this.finish();
      this.accept!(response);
    } catch (error) {
      this.fail(ControlGuard.failure(error));
    }
  }
  private validate(): void {
    ControlGuard.require(!this.signal.aborted, 'SANDBOX_CANCELLED');
    ControlSocketIdentity.verify(this.directory, this.identity);
    this.authority.verify(this.record);
    SandboxControlBinding.assertRequest(this.request, this.record.grant, Date.now());
  }
  private closed(): void {
    if (!this.done) this.failed();
  }
  private failed(): void {
    this.fail('SANDBOX_PROVIDER_UNAVAILABLE');
  }
  private cancel(): void {
    this.fail('SANDBOX_CANCELLED');
  }
  private fail(code: SandboxControlCode): void {
    if (this.done) return;
    this.finish();
    this.reject!(new SandboxControlError(code));
  }
  private finish(): void {
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    this.signal.removeEventListener('abort', this.cancellation);
    this.socket.destroy();
  }
}

export class SandboxSocketClient implements SandboxControlClient {
  private readonly configuration: z.infer<typeof ControlSchemas.client>;
  constructor(input: unknown) {
    this.configuration = ControlSchemas.parse(ControlSchemas.client, input);
  }
  private async request(
    operation: SandboxControlRequest['operation'],
    parameters: object,
    signal: AbortSignal,
  ): Promise<Extract<SandboxControlResponse, { success: true }>> {
    const config = this.configuration;
    const authority = new ControlAuthority(config.authorityFile, config.scope);
    const record = authority.read();
    const request = SandboxControlBinding.assertRequest(
      {
        schemaVersion: 'treeseed.sandbox-control/v1',
        requestId: randomUUID(),
        scope: config.scope,
        operation,
        parameters,
      },
      record.grant,
      Date.now(),
    );
    const response = await this.exchange(request, authority, record, signal);
    if (!response.success) throw new SandboxControlError(response.problem.code);
    return response;
  }
  private async exchange(
    request: SandboxControlRequest,
    authority: ControlAuthority,
    record: ControlAuthorityRecord,
    signal: AbortSignal,
  ): Promise<SandboxControlResponse> {
    let directory: SafeDirectory | null = null;
    try {
      directory = SafeDirectory.open(this.configuration.endpointDirectory);
      return await new ControlExchange(
        directory,
        request,
        authority,
        record,
        signal,
        this.configuration.timeoutMs,
      ).run();
    } catch (error) {
      if (error instanceof SandboxControlError) throw error;
      throw new SandboxControlError('SANDBOX_OPERATION_FAILED');
    } finally {
      directory?.close();
    }
  }
  async ready(signal: AbortSignal): Promise<SandboxAvailability> {
    return SandboxControlSchemas.availability.parse(
      (await this.request('ready', {}, signal)).result,
    );
  }
  async create(sandboxId: string, signal: AbortSignal): Promise<SandboxEvidence> {
    return SandboxControlSchemas.evidence.parse(
      (await this.request('create', { sandboxId }, signal)).result,
    );
  }
  async inspect(sandboxId: string, signal: AbortSignal): Promise<SandboxEvidence> {
    return SandboxControlSchemas.evidence.parse(
      (await this.request('inspect', { sandboxId }, signal)).result,
    );
  }
  async assign(
    sandboxId: string,
    assignmentId: string,
    environmentId: string,
    signal: AbortSignal,
  ): Promise<SandboxAssignment> {
    return SandboxControlSchemas.assignment.parse(
      (await this.request('assign', { sandboxId, assignmentId, environmentId }, signal)).result,
    );
  }
  async execute(
    sandboxId: string,
    phase: 'setup' | 'verification',
    signal: AbortSignal,
  ): Promise<SandboxPhaseReceipt> {
    return SandboxControlSchemas.receipt.parse(
      (await this.request('execute', { sandboxId, phase }, signal)).result,
    );
  }
  async destroy(sandboxId: string, signal: AbortSignal): Promise<SandboxDestructionReceipt> {
    return SandboxControlSchemas.destruction.parse(
      (await this.request('destroy', { sandboxId }, signal)).result,
    );
  }
}

interface ControlEndpoint {
  start(): Promise<void>;
  close(): Promise<void>;
}
const ControlEndpointToken = new CapabilityToken<ControlEndpoint>(
  'host.sandbox.control',
  ProviderV4Schemas.version,
  new ControlMethods(['start', 'close']),
);
class EndpointConfiguration {
  static readonly schema = z.strictObject({
    scope: SandboxControlSchemas.scope,
    endpointDirectory: PlatformSchemas.absolute,
    authorityFile: PlatformSchemas.absolute,
    configurationDigest: PlatformSchemas.digest,
  });
  static readonly root = z.strictObject({
    scope: SandboxControlSchemas.scope,
    endpointDirectory: PlatformSchemas.absolute,
    authorityFile: PlatformSchemas.absolute,
    socketLibrary: ControlSchemas.pin,
    host: KataSandboxPlugin.Config,
    artifact: PlatformSchemas.artifact,
  });
}
type ControlConfiguration = z.infer<typeof EndpointConfiguration.schema>;
type RootConfiguration = z.infer<typeof EndpointConfiguration.root>;
type WorkloadHost = KataSandboxHost & Pick<SandboxControlClient, 'assign' | 'execute'>;

class ControlDispatch {
  constructor(
    private readonly context: Context,
    private readonly configuration: ControlConfiguration,
  ) {}
  private host(input: KataSandboxHost): WorkloadHost {
    for (const name of ['assign', 'execute'])
      ControlGuard.require(
        typeof Reflect.get(input, name) === 'function',
        'SANDBOX_PROVIDER_UNAVAILABLE',
      );
    return input as WorkloadHost;
  }
  async ready(): Promise<void> {
    const lease = await CordisServiceLocator.from(this.context).acquire(KataSandboxToken);
    try {
      await this.host(lease.value).ready();
    } finally {
      await lease.release();
    }
  }
  async execute(request: SandboxControlRequest, signal: AbortSignal): Promise<unknown> {
    const lease = await CordisServiceLocator.from(this.context).acquire(KataSandboxToken);
    try {
      return await this.operation(this.host(lease.value), request, signal);
    } finally {
      await lease.release();
    }
  }
  private async operation(
    host: WorkloadHost,
    request: SandboxControlRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    switch (request.operation) {
      case 'ready':
        return this.availability(host);
      case 'create':
        return this.evidence(await host.create(request.parameters.sandboxId, signal));
      case 'inspect':
        return this.evidence(await host.inspect(request.parameters.sandboxId, signal));
      case 'assign':
        return host.assign(
          request.parameters.sandboxId,
          request.parameters.assignmentId,
          request.parameters.environmentId,
          signal,
        );
      case 'execute':
        return host.execute(request.parameters.sandboxId, request.parameters.phase, signal);
      case 'destroy':
        return this.destruction(await host.destroy(request.parameters.sandboxId, signal));
    }
  }
  private async availability(host: WorkloadHost): Promise<SandboxAvailability> {
    await host.ready();
    return {
      state: 'available',
      configurationDigest: this.configuration.configurationDigest,
      capabilityVersion: SandboxControlSchemas.version,
    };
  }
  private evidence(input: Awaited<ReturnType<KataSandboxHost['inspect']>>): SandboxEvidence {
    ControlGuard.require(Object.hasOwn(input, 'assignment'), 'SANDBOX_PROVIDER_UNAVAILABLE');
    return SandboxControlSchemas.evidence.parse({
      sandboxId: input.id,
      inspectionDigest: input.inspectionDigest,
      assignment: Reflect.get(input, 'assignment'),
    });
  }
  private destruction(
    input: Awaited<ReturnType<KataSandboxHost['destroy']>>,
  ): SandboxDestructionReceipt {
    return SandboxControlSchemas.destruction.parse({
      sandboxId: input.id,
      destroyed: input.destroyed,
      inspectionDigest: input.inspectionDigest,
    });
  }
}
class ControlConnection {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private accepted = false;
  private finished = false;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private pending: Promise<void> | null = null;
  constructor(
    private readonly socket: Socket,
    private readonly endpoint: SandboxControlPlugin,
    private readonly authority: ControlAuthority,
    private readonly dispatch: ControlDispatch,
  ) {
    this.timer = setTimeout(this.cancel.bind(this), 10000);
    socket.on('data', this.data.bind(this));
    socket.once('error', this.cancel.bind(this));
    socket.once('close', this.closed.bind(this));
  }
  private data(bytes: Buffer): void {
    if (this.finished) return;
    if (this.accepted || this.bytes + bytes.length > 65536) return this.cancel();
    this.bytes += bytes.length;
    this.chunks.push(bytes);
    const frame = Buffer.concat(this.chunks);
    const newline = frame.indexOf(10);
    if (newline < 0) return;
    if (newline !== frame.length - 1) return this.cancel();
    this.accepted = true;
    clearTimeout(this.timer);
    this.pending = this.execute(frame.subarray(0, -1));
    void this.pending.finally(this.settled.bind(this));
  }
  private async execute(bytes: Buffer): Promise<void> {
    let frame: z.infer<typeof ControlSchemas.frame>;
    let record: ControlAuthorityRecord;
    try {
      frame = ControlSchemas.parse(ControlSchemas.frame, StrictJson.parse(bytes));
      record = this.authority.read();
      this.authority.authenticate(frame.credential, record);
    } catch {
      this.cancel();
      return;
    }
    await this.admitted(frame.request, record);
  }
  private async admitted(
    request: SandboxControlRequest,
    record: ControlAuthorityRecord,
  ): Promise<void> {
    const expiry = setTimeout(
      this.cancel.bind(this),
      Math.max(1, Math.min(120000, record.grant.expiresAtEpochMs - Date.now())),
    );
    try {
      this.endpoint.verify();
      SandboxControlBinding.assertRequest(request, record.grant, Date.now());
      const result = await this.dispatch.execute(request, this.controller.signal);
      this.endpoint.verify();
      this.authority.verify(record);
      SandboxControlBinding.assertRequest(request, record.grant, Date.now());
      ControlGuard.require(!this.controller.signal.aborted, 'SANDBOX_CANCELLED');
      this.respond({ ...this.envelope(request), success: true, result, problem: null });
    } catch (error) {
      this.problem(request, ControlGuard.failure(error));
    } finally {
      clearTimeout(expiry);
    }
  }
  private envelope(request: SandboxControlRequest): object {
    return {
      schemaVersion: request.schemaVersion,
      requestId: request.requestId,
      scope: request.scope,
      operation: request.operation,
    };
  }
  private problem(request: SandboxControlRequest, code: SandboxControlCode): void {
    this.respond({ ...this.envelope(request), success: false, result: null, problem: { code } });
  }
  private respond(input: unknown): void {
    if (this.finished) return;
    try {
      const response = SandboxControlSchemas.response.parse(input);
      this.finished = true;
      clearTimeout(this.timer);
      this.socket.end(CanonicalJson.stringify(response) + '\n');
    } catch {
      this.cancel();
    }
  }
  cancel(): void {
    this.finished = true;
    clearTimeout(this.timer);
    this.controller.abort();
    this.socket.destroy();
    if (!this.pending) this.settled();
  }
  private closed(): void {
    this.controller.abort();
    if (!this.pending) this.settled();
  }
  private settled(): void {
    this.endpoint.settled(this);
  }
  async drain(): Promise<void> {
    this.cancel();
    if (this.pending) await this.pending;
  }
}

/** Native endpoint lifetime and authentication are one coherent host security boundary. */
export class SandboxControlPlugin implements ControlEndpoint {
  static readonly provide = ['host.sandbox.control'];
  static readonly inject = ['host.socket.unix', 'host.sandbox.kata'];
  static readonly Config = EndpointConfiguration.schema;
  static readonly declaration = ProviderV4Schemas.declaration.parse({
    id: 'deployment.sandbox.control',
    pluginId: 'deployment',
    capability: this.provide[0],
    contractVersion: ProviderV4Schemas.version,
    target: 'deployment',
    provide: this.provide,
    inject: this.inject,
  });
  private readonly server: Server = createServer(this.connected.bind(this));
  private readonly connections = new Set<ControlConnection>();
  private readonly authority: ControlAuthority;
  private readonly dispatch: ControlDispatch;
  private directory: SafeDirectory | null = null;
  private identity: Stats | null = null;
  private socketLease: ProviderLease<SocketFactory> | null = null;
  private stopping: Promise<void> | null = null;
  private closed = false;
  constructor(
    private readonly context: Context,
    private readonly configuration: ControlConfiguration,
  ) {
    this.authority = new ControlAuthority(configuration.authorityFile, configuration.scope);
    this.dispatch = new ControlDispatch(context, configuration);
    this.server.on('error', this.serverError.bind(this));
    context.provide('host.sandbox.control', this);
    context.effect(this.effect.bind(this));
  }
  private effect(): () => Promise<void> {
    return this.close.bind(this);
  }
  private serverError(): void {
    for (const connection of this.connections) connection.cancel();
  }
  async start(): Promise<void> {
    ControlGuard.require(!this.directory && !this.closed, 'SANDBOX_REPAIR_REQUIRED');
    const record = this.admission();
    await this.dispatch.ready();
    this.directory = SafeDirectory.open(this.configuration.endpointDirectory);
    this.socketLease = await CordisServiceLocator.from(this.context).acquire(UnixSocketToken);
    const fd = await this.socketLease.value.bind(this.directory);
    this.identity = ControlSocketIdentity.read(this.directory);
    await new Promise<void>(this.listen.bind(this, fd));
    this.verify();
    this.authority.verify(record);
  }
  private admission(): ControlAuthorityRecord {
    const record = this.authority.read();
    SandboxControlBinding.assertRequest(
      {
        schemaVersion: 'treeseed.sandbox-control/v1',
        requestId: randomUUID(),
        scope: this.configuration.scope,
        operation: 'ready',
        parameters: {},
      },
      record.grant,
      Date.now(),
    );
    return record;
  }
  private listen(fd: number, accept: () => void, reject: (error: Error) => void): void {
    this.server.once('error', reject);
    this.server.listen({ fd }, this.listening.bind(this, accept, reject));
  }
  private listening(accept: () => void, reject: (error: Error) => void): void {
    this.server.removeListener('error', reject);
    accept();
  }
  verify(): void {
    ControlGuard.require(
      this.directory && this.identity && !this.closed && !this.stopping,
      'SANDBOX_RESOURCE_CHANGED',
    );
    ControlSocketIdentity.verify(this.directory, this.identity);
  }
  private connected(socket: Socket): void {
    try {
      this.verify();
      ControlGuard.require(this.connections.size < 16, 'SANDBOX_CAPACITY_LIMIT');
      this.connections.add(new ControlConnection(socket, this, this.authority, this.dispatch));
    } catch {
      socket.destroy();
    }
  }
  settled(connection: ControlConnection): void {
    this.connections.delete(connection);
  }
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.stopping) this.stopping = this.dispose();
    return this.stopping;
  }
  private async dispose(): Promise<void> {
    try {
      await this.stopped();
      if (this.directory && this.identity) {
        ControlSocketIdentity.verify(this.directory, this.identity);
        unlinkSync(this.directory.childPath('control.sock'));
      }
      this.directory?.close();
      this.directory = null;
      await this.socketLease?.release();
      this.socketLease = null;
      this.closed = true;
    } catch (error) {
      this.stopping = null;
      throw error;
    }
  }
  private async stopped(): Promise<void> {
    const draining: Promise<void>[] = [];
    for (const connection of this.connections) draining.push(connection.drain());
    if (this.server.listening) await new Promise<void>(this.stopServer.bind(this));
    const results = await Promise.allSettled(draining);
    for (const result of results)
      ControlGuard.require(result.status === 'fulfilled', 'SANDBOX_REPAIR_REQUIRED');
  }
  private stopServer(accept: () => void, reject: (error: Error) => void): void {
    this.server.close(this.serverClosed.bind(this, accept, reject));
  }
  private serverClosed(accept: () => void, reject: (error: Error) => void, error?: Error): void {
    if (error) reject(error);
    else accept();
  }
}

export class SandboxControlApplication {
  private constructor(
    private readonly scope: CordisScope,
    private readonly lease: ProviderLease<ControlEndpoint>,
  ) {}
  get generation(): string {
    return this.scope.generation;
  }
  static async start(input: unknown): Promise<SandboxControlApplication> {
    const configuration = ControlSchemas.parse(EndpointConfiguration.root, input);
    this.scopeBinding(configuration);
    const scope = await CordisScope.start(
      this.descriptor(configuration),
      this.context(configuration),
    );
    let lease: ProviderLease<ControlEndpoint> | null = null;
    try {
      lease = await scope.acquire(ControlEndpointToken);
      await lease.value.start();
      return new SandboxControlApplication(scope, lease);
    } catch (error) {
      return this.abandon(scope, lease, error);
    }
  }
  private static async abandon(
    scope: CordisScope,
    lease: ProviderLease<ControlEndpoint> | null,
    error: unknown,
  ): Promise<never> {
    try {
      await lease?.release();
      await scope.dispose();
    } catch {
      throw new SandboxControlError('SANDBOX_REPAIR_REQUIRED');
    }
    throw new SandboxControlError(ControlGuard.failure(error));
  }
  private static scopeBinding(configuration: RootConfiguration): void {
    const scope = configuration.scope;
    const host = configuration.host.scope;
    ControlGuard.require(
      scope.installationId === host.installationId &&
        scope.serviceId === host.serviceId &&
        scope.providerGeneration === host.providerGeneration,
      'SANDBOX_SCOPE_MISMATCH',
    );
    ControlGuard.require(
      configuration.artifact.package === '@treeseed-cordis/deployment',
      'INVALID_SANDBOX_CONTROL_CONTRACT',
    );
  }
  private static context(configuration: RootConfiguration): {
    scopeId: string;
    target: 'deployment';
    principalId: string;
    resourceScope: string;
  } {
    return {
      scopeId: 'sandbox-control:' + CanonicalJson.digest(configuration.scope),
      target: 'deployment',
      principalId: 'uid:' + process.getuid!(),
      resourceScope: configuration.scope.installationId,
    };
  }
  private static descriptor(configuration: RootConfiguration): {
    registrations: ProviderRegistration[];
    selections: Array<{ scopeId: string; capability: string; providerId: string }>;
  } {
    const registrations = this.registrations(configuration);
    const selections = [];
    const scopeId = this.context(configuration).scopeId;
    for (const registration of registrations)
      selections.push({
        scopeId,
        capability: registration.token.id,
        providerId: ProviderV4Schemas.declaration.parse(registration.declaration).id,
      });
    return { registrations, selections };
  }
  private static registrations(configuration: RootConfiguration): ProviderRegistration[] {
    const control = {
      scope: configuration.scope,
      endpointDirectory: configuration.endpointDirectory,
      authorityFile: configuration.authorityFile,
      configurationDigest: CanonicalJson.digest(configuration.host),
    };
    const registrations = [
      this.registration(
        UnixSocketPlugin,
        UnixSocketToken,
        configuration.socketLibrary,
        configuration,
      ),
      this.registration(KataSandboxPlugin, KataSandboxToken, configuration.host, configuration),
      this.registration(SandboxControlPlugin, ControlEndpointToken, control, configuration),
    ];
    return registrations;
  }
  private static registration(
    plugin: typeof UnixSocketPlugin | typeof KataSandboxPlugin | typeof SandboxControlPlugin,
    token: CapabilityToken,
    configuration: unknown,
    root: RootConfiguration,
  ): ProviderRegistration {
    return {
      plugin: plugin as unknown as ProviderRegistration['plugin'],
      token,
      configuration,
      declaration: plugin.declaration,
      artifact: { kind: 'bundled', identity: CanonicalJson.digest(root.artifact) },
    };
  }
  async close(): Promise<void> {
    try {
      await this.lease.value.close();
      await this.lease.release();
      await this.scope.dispose();
    } catch (error) {
      throw new SandboxControlError(ControlGuard.failure(error));
    }
  }
}

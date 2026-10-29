import { z } from 'zod';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  lstatSync,
  chmodSync,
  type Stats,
} from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Library } from 'bun:ffi';
import {
  CanonicalJson,
  PlatformSchemas,
  ProviderV4Schemas,
  CapabilityToken,
  SandboxControlSchemas,
  SandboxControlError,
  type SandboxControlScope,
  type SandboxControlCode,
} from '@treeseed-cordis/sdk';
import { Context } from '@treeseed-cordis/sdk/runtime';
import { SafeDirectory, StrictJson } from './filesystem.js';
export class ControlGuard {
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
export class ControlSchemas {
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
export type ControlAuthorityRecord = z.infer<typeof ControlSchemas.authority>;
export interface SocketFactory {
  bind(directory: SafeDirectory): Promise<number>;
  close(): void;
}
export class ControlMethods<T extends object> {
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

export class ControlAuthority {
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
export class ControlSocketIdentity {
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
    this.same(this.read(directory), expected);
  }
  static same(actual: Stats, expected: Stats): void {
    ControlGuard.require(
      actual.isSocket() &&
        actual.nlink === 1 &&
        actual.uid === expected.uid &&
        (actual.mode & 0o777) === 0o600 &&
        actual.dev === expected.dev &&
        actual.ino === expected.ino &&
        actual.ctimeMs === expected.ctimeMs,
      'SANDBOX_RESOURCE_CHANGED',
    );
  }
}

/** Affine Linux inode reference; pathname validation remains separate from kernel dialing. */
export class ControlSocketReference {
  private static readonly oPath = 0x200000;
  private readonly identity: Stats;
  private descriptor: number | null = null;
  constructor(private readonly directory: SafeDirectory) {
    ControlGuard.require(process.platform === 'linux', 'SANDBOX_PROVIDER_UNAVAILABLE');
    this.identity = ControlSocketIdentity.read(directory);
    this.descriptor = openSync(
      directory.childPath('control.sock'),
      ControlSocketReference.oPath | constants.O_NOFOLLOW,
    );
    try {
      this.verify();
    } catch (error) {
      if (!this.close()) throw new SandboxControlError('SANDBOX_REPAIR_REQUIRED');
      throw error;
    }
  }
  get path(): string {
    ControlGuard.require(this.descriptor !== null, 'SANDBOX_RESOURCE_CHANGED');
    return '/proc/self/fd/' + this.descriptor;
  }
  verify(): void {
    ControlGuard.require(this.descriptor !== null, 'SANDBOX_RESOURCE_CHANGED');
    ControlSocketIdentity.verify(this.directory, this.identity);
    ControlSocketIdentity.same(fstatSync(this.descriptor), this.identity);
  }
  close(): boolean {
    const fd = this.descriptor;
    if (fd === null) return true;
    this.descriptor = null;
    try {
      closeSync(fd);
      return true;
    } catch {
      return false;
    }
  }
}

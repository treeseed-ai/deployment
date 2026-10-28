import { z } from 'zod';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  readFileSync,
  lstatSync,
  fstatSync,
  fsyncSync,
  rmdirSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { release, arch } from 'node:os';
import {
  CanonicalJson,
  PlatformSchemas,
  CapabilityToken,
  ProviderV4Schemas,
} from '@treeseed-cordis/sdk';
import { Context } from '@treeseed-cordis/sdk/runtime';
import { SafeDirectory, StrictJson } from './filesystem.js';
import { InstallationStore } from './installed.js';
import { SandboxProcessObserver, type SandboxProcessIdentity } from './kata-hypervisor.js';

class KataConfiguration {
  static readonly file = z.strictObject({
    path: PlatformSchemas.absolute,
    sha256: PlatformSchemas.digest,
  });
  static readonly scope = z.strictObject({
    installationId: PlatformSchemas.text,
    serviceId: PlatformSchemas.slot,
    providerGeneration: PlatformSchemas.digest,
  });
  static readonly schema = z.strictObject({
    scope: this.scope,
    custody: PlatformSchemas.absolute,
    endpointDirectory: PlatformSchemas.absolute,
    daemon: z.strictObject({
      pid: z.number().int().positive(),
      startTime: z.string().regex(/^[0-9]+$/),
      commandDigest: PlatformSchemas.digest,
    }),
    client: this.file,
    runtime: z.strictObject({
      version: z.literal('4.1.0'),
      guestKernel: z.string().regex(/^[0-9][a-zA-Z0-9._+-]{0,127}$/),
      shim: this.file,
      hypervisor: this.file,
      configuration: this.file,
    }),
    image: z
      .string()
      .regex(
        /^(?:[a-zA-Z0-9][a-zA-Z0-9.-]*(?::[0-9]+)?\/)?(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[a-f0-9]{64}$/,
      ),
    maximumSandboxes: z.number().int().min(1).max(4096).default(64),
  });
  static parse(value: unknown): KataBackendConfiguration {
    const result = this.schema.safeParse(value);
    KataSandboxError.require(result.success, 'KATA_CONFIGURATION_INVALID');
    return result.data;
  }
  static requireHost(): void {
    try {
      const os = readFileSync('/etc/os-release', 'utf8');
      KataSandboxError.require(
        /^ID=ubuntu$/m.test(os) && /^VERSION_ID="?26\.04"?$/m.test(os),
        'KATA_HOST_UNQUALIFIED',
      );
      KataSandboxError.require(
        process.platform === 'linux' &&
          arch() === 'x64' &&
          process.getuid?.() === 0 &&
          lstatSync('/dev/kvm').isCharacterDevice(),
        'KATA_HOST_UNQUALIFIED',
      );
    } catch {
      throw new KataSandboxError('KATA_HOST_UNQUALIFIED');
    }
  }
}
export type KataBackendConfiguration = z.infer<typeof KataConfiguration.schema>;
export interface KataSandboxEvidence {
  id: string;
  resourceName: string;
  kernel: string;
  inspectionDigest: string;
  hypervisor: SandboxProcessIdentity;
}
export interface KataSandboxDestruction {
  id: string;
  destroyed: true;
  inspectionDigest: string;
}
export interface KataSandboxHost {
  ready(): Promise<void>;
  create(id: string, signal: AbortSignal): Promise<KataSandboxEvidence>;
  inspect(id: string, signal: AbortSignal): Promise<KataSandboxEvidence>;
  destroy(id: string, signal: AbortSignal): Promise<KataSandboxDestruction>;
  close(): Promise<void>;
}
class KataHostAdapter {
  parse(value: unknown): KataSandboxHost {
    KataSandboxError.require(value && typeof value === 'object', 'KATA_PROVIDER_INVALID');
    for (const method of ['ready', 'create', 'inspect', 'destroy', 'close'])
      KataSandboxError.require(
        typeof Reflect.get(value, method) === 'function',
        'KATA_PROVIDER_INVALID',
      );
    return value as KataSandboxHost;
  }
}
export const KataSandboxToken = new CapabilityToken<KataSandboxHost>(
  'host.sandbox.kata',
  ProviderV4Schemas.version,
  new KataHostAdapter(),
);
export class KataSandboxError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'KataSandboxError';
  }
  static require(value: unknown, code: string): asserts value {
    if (!value) throw new KataSandboxError(code);
  }
}

class KataExecutable {
  static verify(file: { path: string; sha256: string }, executable = false): void {
    const directory = SafeDirectory.open(dirname(file.path));
    try {
      const name = file.path.slice(dirname(file.path).length + 1);
      const stat = lstatSync(directory.childPath(name));
      KataSandboxError.require(!stat.isSymbolicLink() && stat.uid === 0, 'KATA_RUNTIME_OWNER');
      const bytes = directory.file(name, file.sha256, 64 * 1024 * 1024);
      if (executable)
        KataSandboxError.require(
          bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && (stat.mode & 0o111) !== 0,
          'KATA_EXECUTABLE_INVALID',
        );
    } finally {
      directory.close();
    }
  }
}

class KataEndpoint {
  private readonly socket: Stats;
  constructor(
    readonly directory: SafeDirectory,
    private readonly configuration: KataBackendConfiguration,
  ) {
    SafeDirectory.owner(fstatSync(directory.fd), true);
    this.socket = lstatSync(directory.childPath('containerd.sock'));
    this.verify();
  }
  verify(): void {
    this.directory.verify();
    const socket = lstatSync(this.directory.childPath('containerd.sock'));
    KataSandboxError.require(
      socket.isSocket() &&
        !socket.isSymbolicLink() &&
        socket.nlink === 1 &&
        socket.uid === process.getuid?.() &&
        (socket.mode & 0o777) === 0o600,
      'KATA_ENDPOINT_OWNER',
    );
    KataSandboxError.require(
      socket.dev === this.socket.dev &&
        socket.ino === this.socket.ino &&
        socket.ctimeMs === this.socket.ctimeMs,
      'KATA_ENDPOINT_CHANGED',
    );
    this.process();
    this.runtimeConfiguration();
    this.executables();
  }
  private executables(): void {
    KataExecutable.verify(this.configuration.client, true);
    KataExecutable.verify(this.configuration.runtime.shim, true);
    KataExecutable.verify(this.configuration.runtime.hypervisor, true);
    KataExecutable.verify(this.configuration.runtime.configuration);
  }
  private process(): void {
    const expected = this.configuration.daemon;
    const root = '/proc/' + expected.pid;
    const stat = readFileSync(root + '/stat', 'utf8');
    const start = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/)[19];
    KataSandboxError.require(
      start === expected.startTime && lstatSync(root).uid === process.getuid?.(),
      'KATA_DAEMON_CHANGED',
    );
    KataSandboxError.require(
      createHash('sha256')
        .update(readFileSync(root + '/cmdline'))
        .digest('hex') === expected.commandDigest,
      'KATA_DAEMON_CHANGED',
    );
  }
  private runtimeConfiguration(): void {
    const root = '/proc/' + this.configuration.daemon.pid;
    const environment = readFileSync(root + '/environ', 'utf8').split('\0');
    KataSandboxError.require(
      environment.includes('KATA_CONF_FILE=' + this.configuration.runtime.configuration.path),
      'KATA_RUNTIME_CONFIGURATION',
    );
  }
  path(): string {
    this.verify();
    return '/proc/' + process.pid + '/fd/' + this.directory.fd + '/containerd.sock';
  }
  identity(): object {
    return { device: this.socket.dev, inode: this.socket.ino, daemon: this.configuration.daemon };
  }
  close(): void {
    this.directory.close();
  }
}

class KataCommand {
  private child: ChildProcess | null = null;
  private readonly chunks: Buffer[] = [];
  private count = 0;
  private failure: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private accept: ((bytes: Buffer) => void) | null = null;
  private reject: ((error: Error) => void) | null = null;
  private readonly cancellation: () => void;
  constructor(
    private readonly executable: string,
    private readonly args: string[],
    private readonly signal: AbortSignal,
  ) {
    this.cancellation = this.cancel.bind(this);
  }
  run(): Promise<Buffer> {
    return new Promise(this.start.bind(this));
  }
  private start(accept: (bytes: Buffer) => void, reject: (error: Error) => void): void {
    this.accept = accept;
    this.reject = reject;
    if (this.signal.aborted) return this.finish(null);
    this.child = spawn(this.executable, this.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
    });
    this.child.once('error', this.failed.bind(this));
    this.child.once('close', this.finish.bind(this));
    this.child.stdout!.on('data', this.output.bind(this));
    this.child.stderr!.on('data', this.discard.bind(this));
    this.signal.addEventListener('abort', this.cancellation, { once: true });
    this.timer = setTimeout(this.timeout.bind(this), 120000);
  }
  private output(bytes: Buffer): void {
    if (this.limit(bytes.length)) this.chunks.push(bytes);
  }
  private discard(bytes: Buffer): void {
    this.limit(bytes.length);
  }
  private limit(size: number): boolean {
    this.count += size;
    if (this.count <= 1024 * 1024) return true;
    this.failure = 'KATA_OUTPUT_LIMIT';
    this.terminate();
    return false;
  }
  private failed(): void {
    this.failure = 'KATA_COMMAND_FAILED';
  }
  private cancel(): void {
    this.failure = 'KATA_CANCELLED';
    this.terminate();
  }
  private timeout(): void {
    this.failure = 'KATA_COMMAND_TIMEOUT';
    this.terminate();
  }
  private terminate(): void {
    this.child?.kill('SIGTERM');
    if (!this.killTimer) this.killTimer = setTimeout(this.kill.bind(this), 1000);
  }
  private kill(): void {
    this.child?.kill('SIGKILL');
  }
  private finish(code: number | null): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.killTimer) clearTimeout(this.killTimer);
    this.signal.removeEventListener('abort', this.cancellation);
    if (this.signal.aborted) this.failure = 'KATA_CANCELLED';
    if (this.failure || code !== 0)
      this.reject!(new KataSandboxError(this.failure ?? 'KATA_COMMAND_FAILED'));
    else this.accept!(Buffer.concat(this.chunks));
  }
}

class KataClient {
  readonly namespace: string;
  constructor(
    private readonly configuration: KataBackendConfiguration,
    readonly endpoint: KataEndpoint,
  ) {
    this.namespace = 'cordis-sandbox-' + CanonicalJson.digest(configuration.scope).slice(0, 24);
  }
  async bytes(args: string[], signal: AbortSignal): Promise<Buffer> {
    this.endpoint.verify();
    const prefix = ['--address', this.endpoint.path(), '--namespace', this.namespace];
    const bytes = await new KataCommand(
      this.configuration.client.path,
      [...prefix, ...args],
      signal,
    ).run();
    this.endpoint.verify();
    return bytes;
  }
  async text(args: string[], signal: AbortSignal): Promise<string> {
    return (await this.bytes(args, signal)).toString('utf8').trim();
  }
  async list(kind: 'containers' | 'tasks', signal: AbortSignal): Promise<string[]> {
    const result = await this.text([kind, 'list', '--quiet'], signal);
    return result ? result.split('\n') : [];
  }
  async preparedImage(signal: AbortSignal): Promise<void> {
    const digest = this.configuration.image.slice(this.configuration.image.lastIndexOf(':') + 1);
    const bytes = await this.content(digest, signal);
    const manifest = StrictJson.object(StrictJson.parse(bytes));
    const config = StrictJson.object(manifest.config);
    KataSandboxError.require(
      typeof config.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(config.digest),
      'KATA_IMAGE_IDENTITY',
    );
    const content = await this.content(config.digest.slice(7), signal);
    const value = StrictJson.object(StrictJson.parse(content));
    KataSandboxError.require(
      value.os === 'linux' && value.architecture === 'amd64',
      'KATA_ARCHITECTURE',
    );
  }
  private async content(digest: string, signal: AbortSignal): Promise<Buffer> {
    const bytes = await this.bytes(['content', 'get', 'sha256:' + digest], signal);
    KataSandboxError.require(
      createHash('sha256').update(bytes).digest('hex') === digest,
      'KATA_IMAGE_IDENTITY',
    );
    return bytes;
  }
  async qualify(signal: AbortSignal): Promise<void> {
    await this.preparedImage(signal);
    await this.emptyNamespace(signal);
  }
  async emptyNamespace(signal: AbortSignal): Promise<void> {
    KataSandboxError.require(
      (await this.list('containers', signal)).length === 0 &&
        (await this.list('tasks', signal)).length === 0,
      'KATA_FOREIGN_RESOURCE',
    );
  }
  async prewarm(name: string, binding: string, signal: AbortSignal): Promise<void> {
    await this.text(
      [
        'run',
        '--detach',
        '--snapshotter',
        'native',
        '--runtime',
        'io.containerd.kata.v2',
        '--label',
        'ai.treeseed.cordis.sandbox=' + binding,
        this.configuration.image,
        name,
        '/bin/sleep',
        '86400',
      ],
      signal,
    );
  }
  async guestKernel(name: string, signal: AbortSignal): Promise<string> {
    return this.text(
      ['tasks', 'exec', '--exec-id', 'inspect-' + randomUUID(), name, '/bin/uname', '-r'],
      signal,
    );
  }
}

interface KataIntent {
  id: string;
  resourceName: string;
  configurationDigest: string;
}
class KataCustody {
  private lock: SafeDirectory | null = null;
  private lockIdentity: Stats | null = null;
  private readonly nonce = randomUUID();
  private constructor(
    private readonly directory: SafeDirectory,
    private readonly digest: string,
    private readonly namespace: string,
  ) {}
  static open(path: string, digest: string, namespace: string): KataCustody {
    const custody = new KataCustody(SafeDirectory.open(path), digest, namespace);
    try {
      custody.initialize();
      custody.acquire();
      return custody;
    } catch (error) {
      custody.lock?.close();
      custody.directory.close();
      throw error;
    }
  }
  private initialize(): void {
    SafeDirectory.owner(fstatSync(this.directory.fd), true);
    if (this.directory.entries().length === 0) {
      InstallationStore.mkdir(this.directory, 'intents').close();
      InstallationStore.mkdir(this.directory, 'destroyed').close();
      InstallationStore.publish(this.directory, 'receipt.json', this.receipt());
    }
    KataSandboxError.require(
      this.directory.entries().join(',') === 'destroyed,intents,receipt.json',
      'KATA_REPAIR_REQUIRED',
    );
    const receipt = StrictJson.parse(this.directory.file('receipt.json', undefined, 1024, true));
    KataSandboxError.require(
      CanonicalJson.stringify(receipt) === CanonicalJson.stringify(this.receipt()),
      'KATA_CUSTODY_SCOPE',
    );
    KataSandboxError.require(this.active().length === 0, 'KATA_REPAIR_REQUIRED');
  }
  private receipt(): object {
    return { formatVersion: 1, configurationDigest: this.digest, namespace: this.namespace };
  }
  private acquire(): void {
    this.lock = InstallationStore.mkdir(this.directory, 'owner.lock');
    this.lockIdentity = fstatSync(this.lock.fd);
    InstallationStore.publish(this.lock, 'owner.json', { pid: process.pid, nonce: this.nonce });
  }
  private name(id: string): string {
    KataSandboxError.require(
      /^sandbox-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id),
      'KATA_SANDBOX_ID',
    );
    return CanonicalJson.digest({ id }) + '.json';
  }
  verify(): void {
    this.directory.verify();
    SafeDirectory.owner(fstatSync(this.directory.fd), true);
    if (!this.lock) return;
    const stat = lstatSync(this.directory.childPath('owner.lock'));
    KataSandboxError.require(
      stat.isDirectory() &&
        stat.dev === this.lockIdentity!.dev &&
        stat.ino === this.lockIdentity!.ino,
      'KATA_WRITER_CHANGED',
    );
    SafeDirectory.owner(stat, true);
    const owner = StrictJson.parse(this.lock.file('owner.json', undefined, 1024, true));
    KataSandboxError.require(
      CanonicalJson.stringify(owner) ===
        CanonicalJson.stringify({ pid: process.pid, nonce: this.nonce }),
      'KATA_WRITER_CHANGED',
    );
  }
  private expected(id: string): KataIntent {
    this.name(id);
    return {
      id,
      resourceName: this.namespace + '-' + CanonicalJson.digest({ id }).slice(0, 24),
      configurationDigest: this.digest,
    };
  }
  intent(id: string): KataIntent {
    this.verify();
    const record = this.expected(id);
    const directory = this.directory.directory('intents', true);
    try {
      KataSandboxError.require(!directory.entries().includes(this.name(id)), 'KATA_SANDBOX_EXISTS');
      InstallationStore.publish(directory, this.name(id), record);
      return record;
    } finally {
      directory.close();
    }
  }
  read(id: string): KataIntent {
    this.verify();
    const directory = this.directory.directory('intents', true);
    try {
      const value = StrictJson.parse(directory.file(this.name(id), undefined, 4096, true));
      const expected = this.expected(id);
      KataSandboxError.require(
        CanonicalJson.stringify(value) === CanonicalJson.stringify(expected),
        'KATA_RESOURCE_SCOPE',
      );
      return expected;
    } finally {
      directory.close();
    }
  }
  private completion(record: KataIntent): KataSandboxDestruction {
    return {
      id: record.id,
      destroyed: true,
      inspectionDigest: CanonicalJson.digest({ record, absent: ['task', 'container', 'snapshot'] }),
    };
  }
  destroyed(id: string): boolean {
    this.verify();
    const directory = this.directory.directory('destroyed', true);
    try {
      if (!directory.entries().includes(this.name(id))) return false;
      const value = StrictJson.parse(directory.file(this.name(id), undefined, 4096, true));
      KataSandboxError.require(
        CanonicalJson.stringify(value) === CanonicalJson.stringify(this.completion(this.read(id))),
        'KATA_RECORD_CHANGED',
      );
      return true;
    } finally {
      directory.close();
    }
  }
  complete(record: KataIntent): KataSandboxDestruction {
    this.verify();
    const result = this.completion(record);
    const directory = this.directory.directory('destroyed', true);
    try {
      InstallationStore.publish(directory, this.name(record.id), result);
    } finally {
      directory.close();
    }
    KataSandboxError.require(this.destroyed(record.id), 'KATA_RECORD_CHANGED');
    return result;
  }
  active(): string[] {
    const result: string[] = [];
    for (const record of this.records()) if (!this.destroyed(record.id)) result.push(record.id);
    return result;
  }
  private records(): KataIntent[] {
    const intents = this.directory.directory('intents', true);
    const destroyed = this.directory.directory('destroyed', true);
    try {
      const names = this.recordNames(intents, destroyed);
      const result: KataIntent[] = [];
      for (const name of names) {
        const value = StrictJson.object(
          StrictJson.parse(intents.file(name, undefined, 4096, true)),
        );
        KataSandboxError.require(
          typeof value.id === 'string' && name === this.name(value.id),
          'KATA_RECORD_CHANGED',
        );
        result.push(this.read(value.id));
      }
      return result;
    } finally {
      intents.close();
      destroyed.close();
    }
  }
  private recordNames(intents: SafeDirectory, destroyed: SafeDirectory): string[] {
    const names = intents.entries();
    const expected = new Set(names);
    KataSandboxError.require(names.length <= 10000, 'KATA_CUSTODY_LIMIT');
    for (const name of destroyed.entries())
      KataSandboxError.require(expected.has(name), 'KATA_RECORD_CHANGED');
    return names;
  }
  close(): void {
    this.verify();
    KataSandboxError.require(this.active().length === 0, 'KATA_SANDBOXES_REMAIN');
    unlinkSync(this.lock!.childPath('owner.json'));
    fsyncSync(this.lock!.fd);
    this.lock!.close();
    rmdirSync(this.directory.childPath('owner.lock'));
    fsyncSync(this.directory.fd);
    this.directory.close();
  }
}

class KataQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action, action);
    this.tail = result.then(this.finished.bind(this), this.finished.bind(this));
    return result;
  }
  private finished(): void {}
}

/** Native ownership of one host resource; resolution and lifecycle remain Cordis-owned. */
export class KataSandboxPlugin implements KataSandboxHost {
  static readonly provide = ['host.sandbox.kata'];
  static readonly inject: string[] = [];
  static readonly Config = KataConfiguration.schema;
  static readonly replacement = {
    kind: 'restart' as const,
    stateVersion: 1,
    qualificationDigest: null,
  };
  static readonly declaration = ProviderV4Schemas.declaration.parse({
    id: 'deployment.sandbox.kata',
    pluginId: 'deployment',
    capability: this.provide[0],
    contractVersion: ProviderV4Schemas.version,
    target: 'deployment',
    provide: this.provide,
    inject: this.inject,
  });
  private backend: Promise<KataSandboxBackend> | null = null;
  private disposal: Promise<void> | null = null;
  private closed = false;
  constructor(
    context: Context,
    private readonly configuration: KataBackendConfiguration,
  ) {
    context.provide('host.sandbox.kata', this);
    context.effect(this.effect.bind(this));
  }
  private effect(): () => Promise<void> {
    return this.close.bind(this);
  }
  private active(): Promise<KataSandboxBackend> {
    KataSandboxError.require(!this.closed && !this.disposal, 'KATA_BACKEND_CLOSED');
    if (!this.backend) this.backend = KataSandboxBackend.open(this.configuration);
    return this.backend;
  }
  async ready(): Promise<void> {
    await this.active();
  }
  async create(id: string, signal: AbortSignal): Promise<KataSandboxEvidence> {
    return (await this.active()).create(id, signal);
  }
  async inspect(id: string, signal: AbortSignal): Promise<KataSandboxEvidence> {
    return (await this.active()).inspect(id, signal);
  }
  async destroy(id: string, signal: AbortSignal): Promise<KataSandboxDestruction> {
    return (await this.active()).destroy(id, signal);
  }
  close(): Promise<void> {
    if (!this.disposal) this.disposal = this.dispose();
    return this.disposal;
  }
  private async dispose(): Promise<void> {
    try {
      if (this.backend) await (await this.backend).close();
      this.closed = true;
    } catch (error) {
      this.disposal = null;
      throw error;
    }
  }
}

/** Privileged bounded host backend. Worker plugins never receive this raw-runtime configuration. */
export class KataSandboxBackend {
  private readonly queue = new KataQueue();
  private readonly processes: SandboxProcessObserver;
  private closing = false;
  private closed = false;
  private disposal: Promise<void> | null = null;
  private constructor(
    private readonly configuration: KataBackendConfiguration,
    private readonly client: KataClient,
    private readonly custody: KataCustody,
  ) {
    this.processes = new SandboxProcessObserver(
      configuration.runtime.hypervisor,
      process.getuid!(),
    );
  }
  static async open(input: unknown): Promise<KataSandboxBackend> {
    const configuration = KataConfiguration.parse(input);
    KataConfiguration.requireHost();
    const directory = SafeDirectory.open(configuration.endpointDirectory);
    try {
      const endpoint = new KataEndpoint(directory, configuration);
      const client = new KataClient(configuration, endpoint);
      const signal = new AbortController().signal;
      await client.qualify(signal);
      const digest = CanonicalJson.digest({ configuration, endpoint: endpoint.identity() });
      const custody = KataCustody.open(configuration.custody, digest, client.namespace);
      return new KataSandboxBackend(configuration, client, custody);
    } catch (error) {
      directory.close();
      throw error;
    }
  }
  private admit(signal: AbortSignal): void {
    KataSandboxError.require(!this.closed && !this.closing, 'KATA_BACKEND_CLOSED');
    KataSandboxError.require(!signal.aborted, 'KATA_CANCELLED');
    this.custody.verify();
    this.client.endpoint.verify();
  }
  create(id: string, signal: AbortSignal): Promise<KataSandboxEvidence> {
    return this.queue.run(this.createOwned.bind(this, id, signal));
  }
  private async createOwned(id: string, signal: AbortSignal): Promise<KataSandboxEvidence> {
    this.admit(signal);
    KataSandboxError.require(
      this.custody.active().length < this.configuration.maximumSandboxes,
      'KATA_CAPACITY_LIMIT',
    );
    const record = this.custody.intent(id);
    const existing = await this.client.list('containers', signal);
    KataSandboxError.require(!existing.includes(record.resourceName), 'KATA_FOREIGN_RESOURCE');
    await this.client.prewarm(record.resourceName, CanonicalJson.digest(record), signal);
    return this.inspection(record, signal);
  }
  inspect(id: string, signal: AbortSignal): Promise<KataSandboxEvidence> {
    return this.queue.run(this.inspectOwned.bind(this, id, signal));
  }
  private async inspectOwned(id: string, signal: AbortSignal): Promise<KataSandboxEvidence> {
    this.admit(signal);
    KataSandboxError.require(!this.custody.destroyed(id), 'KATA_SANDBOX_DESTROYED');
    return this.inspection(this.custody.read(id), signal);
  }
  private async resource(record: KataIntent, signal: AbortSignal): Promise<void> {
    const bytes = await this.client.bytes(['containers', 'info', record.resourceName], signal);
    const info = StrictJson.object(StrictJson.parse(bytes));
    const runtime = StrictJson.object(info.Runtime);
    const labels = StrictJson.object(info.Labels);
    KataSandboxError.require(
      info.ID === record.resourceName &&
        info.Image === this.configuration.image &&
        info.SnapshotKey === record.resourceName &&
        runtime.Name === 'io.containerd.kata.v2' &&
        labels['ai.treeseed.cordis.sandbox'] === CanonicalJson.digest(record),
      'KATA_RESOURCE_CHANGED',
    );
  }
  private async inspection(record: KataIntent, signal: AbortSignal): Promise<KataSandboxEvidence> {
    await this.resource(record, signal);
    KataSandboxError.require(
      (await this.client.list('tasks', signal)).includes(record.resourceName),
      'KATA_TASK_NOT_RUNNING',
    );
    const kernel = await this.client.guestKernel(record.resourceName, signal);
    KataSandboxError.require(
      kernel === this.configuration.runtime.guestKernel && kernel !== release(),
      'KATA_GUEST_UNQUALIFIED',
    );
    const hypervisor = this.processes.observe(record.resourceName);
    return {
      id: record.id,
      resourceName: record.resourceName,
      kernel,
      hypervisor,
      inspectionDigest: CanonicalJson.digest({ record, kernel, hypervisor }),
    };
  }
  destroy(id: string, signal: AbortSignal): Promise<KataSandboxDestruction> {
    return this.queue.run(this.destroyOwned.bind(this, id, signal));
  }
  private async destroyOwned(id: string, signal: AbortSignal): Promise<KataSandboxDestruction> {
    this.admit(signal);
    const record = this.custody.read(id);
    const previous = this.processes.capture(record.resourceName);
    if ((await this.client.list('containers', signal)).includes(record.resourceName))
      await this.remove(record, signal);
    await this.removed(record, signal, previous);
    return this.custody.complete(record);
  }
  private async removed(
    record: KataIntent,
    signal: AbortSignal,
    previous: SandboxProcessIdentity | null,
  ): Promise<void> {
    KataSandboxError.require(
      !(await this.client.list('containers', signal)).includes(record.resourceName) &&
        !(await this.client.list('tasks', signal)).includes(record.resourceName),
      'KATA_CLEANUP_FAILED',
    );
    const snapshots = await this.client.text(
      ['snapshots', '--snapshotter', 'native', 'list'],
      signal,
    );
    for (const line of snapshots.split('\n').slice(1))
      KataSandboxError.require(
        line.trim().split(/\s+/)[0] !== record.resourceName,
        'KATA_CLEANUP_FAILED',
      );
    await this.processes.waitGone(record.resourceName, signal, previous ?? undefined);
  }
  private async remove(record: KataIntent, signal: AbortSignal): Promise<void> {
    await this.resource(record, signal);
    if ((await this.client.list('tasks', signal)).includes(record.resourceName)) {
      await this.client.text(['tasks', 'kill', '--signal', 'SIGKILL', record.resourceName], signal);
      await this.client.text(['tasks', 'delete', '--force', record.resourceName], signal);
    }
    await this.client.text(['containers', 'delete', record.resourceName], signal);
  }
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closing = true;
    if (!this.disposal) this.disposal = this.queue.run(this.dispose.bind(this));
    return this.disposal;
  }
  private async dispose(): Promise<void> {
    try {
      await this.client.emptyNamespace(new AbortController().signal);
      this.custody.close();
      this.client.endpoint.close();
      this.closed = true;
    } catch (error) {
      this.closing = false;
      this.disposal = null;
      throw error;
    }
  }
}

export { SandboxSocketClient } from './sandbox-client.js';
export { UnixSocketPlugin, UnixSocketToken } from './sandbox-io.js';
import { z } from 'zod';
import { createServer, type Socket, type Server } from 'node:net';
import { closeSync, unlinkSync, type Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  CanonicalJson,
  PlatformSchemas,
  ProviderV4Schemas,
  CapabilityToken,
  SandboxControlSchemas,
  SandboxControlBinding,
  SandboxControlError,
  type SandboxControlScope,
  type SandboxControlRequest,
  type SandboxControlClient,
  type SandboxControlCode,
  type SandboxAvailability,
  type SandboxEvidence,
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
import { KataSandboxPlugin, KataSandboxToken, type KataSandboxHost } from './kata-backend.js';
import {
  ControlGuard,
  ControlSchemas,
  ControlMethods,
  ControlAuthority,
  ControlSocketIdentity,
  UnixSocketPlugin,
  UnixSocketToken,
  type ControlAuthorityRecord,
  type SocketFactory,
} from './sandbox-io.js';
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
  static readonly inject = ['cordis.composition', 'host.socket.unix', 'host.sandbox.kata'];
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
    await this.adopt(fd);
    this.verify();
    this.authority.verify(record);
  }
  private adopt(fd: number): Promise<void> {
    try {
      this.identity = ControlSocketIdentity.read(this.directory!);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    return new Promise<void>(this.listen.bind(this, fd));
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

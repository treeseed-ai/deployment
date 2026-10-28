import { z } from 'zod';
import { CapabilityToken, ProviderV4Schemas, SandboxControlSchemas } from '@treeseed-cordis/sdk';
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createServer, type Socket, type Server } from 'node:net';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  realpathSync,
  renameSync,
  existsSync,
  fstatSync,
  closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  SandboxSocketClient,
  UnixSocketPlugin,
  UnixSocketToken,
  SandboxControlPlugin,
} from '../../src/sandbox-channel.js';
import { KataSandboxPlugin, KataSandboxToken } from '../../src/kata-backend.js';
import { SafeDirectory } from '../../src/filesystem.js';
import {
  Context,
  CordisScope,
  type ProviderRegistration,
  type ProviderLease,
} from '@treeseed-cordis/sdk/runtime';

interface FixtureEndpoint { start(): Promise<void>; close(): Promise<void> }
class FixtureEndpointAdapter {
  parse(input: unknown): FixtureEndpoint {
    assert(input && typeof input === 'object');
    assert.equal(typeof Reflect.get(input, 'start'), 'function');
    assert.equal(typeof Reflect.get(input, 'close'), 'function');
    return input as FixtureEndpoint;
  }
}
/** Native real binder with a deliberate filesystem race; no VM or daemon fixture. */
class ReplacedSocketFixture extends UnixSocketPlugin {
  static descriptor = -1;
  override async bind(directory: SafeDirectory): Promise<number> {
    const fd = await super.bind(directory);
    ReplacedSocketFixture.descriptor = fd;
    renameSync(directory.childPath('control.sock'), directory.childPath('retained.sock'));
    writeFileSync(directory.childPath('control.sock'), 'foreign-before-adoption', { mode: 0o600 });
    return fd;
  }
}
/** Host contract fixture only; no sandbox operation is exercised in this IO race case. */
class UnusedKataFixture {
  static readonly provide = KataSandboxPlugin.provide;
  static readonly inject: string[] = [];
  static readonly Config = z.strictObject({});
  static readonly declaration = KataSandboxPlugin.declaration;
  constructor(context: Context) { context.provide(KataSandboxToken.id, this); }
  async ready(): Promise<void> {}
  async close(): Promise<void> {}
  async create(): Promise<never> { throw new Error('UNEXPECTED_FIXTURE_HOST_OPERATION'); }
  async inspect(): Promise<never> { throw new Error('UNEXPECTED_FIXTURE_HOST_OPERATION'); }
  async assign(): Promise<never> { throw new Error('UNEXPECTED_FIXTURE_HOST_OPERATION'); }
  async execute(): Promise<never> { throw new Error('UNEXPECTED_FIXTURE_HOST_OPERATION'); }
  async destroy(): Promise<never> { throw new Error('UNEXPECTED_FIXTURE_HOST_OPERATION'); }
}
class UnixPeerFixture {
  readonly directory = mkdtempSync(join(tmpdir(), 'sandbox-peer-'));
  readonly path = join(this.directory, 'control.sock');
  readonly authorityFile = join(this.directory, 'authority.json');
  readonly scope = {
    installationId: 'installation:fixture',
    serviceId: 'worker',
    providerGeneration: 'a'.repeat(64),
    serviceGeneration: 'b'.repeat(64),
  };
  private readonly server = createServer(this.connected.bind(this));
  private readonly sockets = new Set<Socket>();
  connections = 0;
  mode: 'valid' | 'foreign' | 'duplicate' | 'secret' = 'valid';
  constructor() {
    writeFileSync(this.authorityFile, JSON.stringify(this.authority()), { mode: 0o600 });
  }
  authority(): object {
    return {
      credential: 'c'.repeat(64),
      grant: {
        schemaVersion: 'treeseed.sandbox-grant/v1',
        id: 'grant:fixture',
        revision: 1,
        scope: this.scope,
        state: 'granted',
        expiresAtEpochMs: Date.now() + 60000,
        operations: ['ready', 'create', 'inspect', 'assign', 'execute', 'destroy'],
      },
    };
  }
  async start(): Promise<void> {
    const ready = once(this.server, 'listening');
    this.server.listen(this.path);
    await ready;
    chmodSync(this.path, 0o600);
  }
  private connected(socket: Socket): void {
    this.connections++;
    this.sockets.add(socket);
    socket.once('data', this.reply.bind(this, socket));
  }
  private reply(socket: Socket, bytes: Buffer): void {
    const frame = JSON.parse(bytes.toString());
    assert.equal(frame.credential, 'c'.repeat(64));
    const request = frame.request;
    const result = {
      state: 'available',
      configurationDigest: 'd'.repeat(64),
      capabilityVersion: '1.0.0-cordis.1',
    };
    const response = {
      schemaVersion: request.schemaVersion,
      requestId: this.mode === 'foreign' ? 'foreign' : request.requestId,
      scope: request.scope,
      operation: 'ready',
      success: true,
      result,
      problem: null,
    };
    socket.end(this.encoded(response) + '\n');
  }
  private encoded(response: unknown): string {
    let text = JSON.stringify(response);
    if (this.mode === 'duplicate')
      text = text.replace('\"success\":true', '\"success\":true,\"success\":true');
    if (this.mode === 'secret') text = '{\"secret-output-canary\":true}';
    return text;
  }
  client(scope = this.scope): SandboxSocketClient {
    return new SandboxSocketClient({
      endpointDirectory: this.directory,
      authorityFile: this.authorityFile,
      scope,
      timeoutMs: 1000,
    });
  }
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    const closed = once(this.server, 'close');
    this.server.close();
    await closed;
  }
}
class SandboxChannelIntegration {
  async peer(): Promise<void> {
    const fixture = new UnixPeerFixture();
    await fixture.start();
    try {
      assert.equal((await fixture.client().ready(new AbortController().signal)).state, 'available');
      fixture.mode = 'foreign';
      await assert.rejects(fixture.client().ready(new AbortController().signal), {
        message: 'SANDBOX_RESPONSE_MISMATCH',
      });
    } finally {
      await fixture.close();
    }
  }
  async scope(): Promise<void> {
    const fixture = new UnixPeerFixture();
    await fixture.start();
    try {
      const client = fixture.client({ ...fixture.scope, serviceId: 'foreign' });
      await assert.rejects(client.ready(new AbortController().signal), {
        message: 'SANDBOX_SCOPE_MISMATCH',
      });
      assert.equal(fixture.connections, 0);
      chmodSync(fixture.authorityFile, 0o644);
      await assert.rejects(fixture.client().ready(new AbortController().signal));
      assert.equal(fixture.connections, 0);
    } finally {
      await fixture.close();
    }
  }
  async unsafeFrames(): Promise<void> {
    const fixture = new UnixPeerFixture();
    await fixture.start();
    try {
      for (const mode of ['duplicate', 'secret'] as const) {
        fixture.mode = mode;
        await assert.rejects(
          fixture.client().ready(new AbortController().signal),
          this.safe.bind(this),
        );
      }
    } finally {
      await fixture.close();
    }
  }
  private safe(error: unknown): boolean {
    assert(error instanceof Error);
    assert.equal(SandboxControlSchemas.code.safeParse(error.message).success, true);
    assert(!error.message.includes('secret-output-canary'));
    return true;
  }
  async cancelled(): Promise<void> {
    const fixture = new UnixPeerFixture();
    await fixture.start();
    try {
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(fixture.client().ready(controller.signal), {
        message: 'SANDBOX_CANCELLED',
      });
      assert.equal(fixture.connections, 0);
    } finally {
      await fixture.close();
    }
  }
  async descriptor(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'sandbox-fd-'));
    const directory = SafeDirectory.open(root);
    const scope = await this.native();
    const lease = await scope.acquire(UnixSocketToken);
    const server = createServer();
    try {
      await this.foreign(directory, lease, server);
    } finally {
      if (server.listening) server.close();
      await lease.release();
      await scope.dispose();
      directory.close();
    }
  }
  private async foreign(
    directory: SafeDirectory,
    lease: ProviderLease<{ bind(directory: SafeDirectory): Promise<number> }>,
    server: Server,
  ): Promise<void> {
    const fd = await lease.value.bind(directory);
    const listening = once(server, 'listening');
    server.listen({ fd });
    await listening;
    const path = directory.childPath('control.sock');
    renameSync(path, directory.childPath('retained.sock'));
    writeFileSync(path, 'foreign-state', { mode: 0o600 });
    const closed = once(server, 'close');
    server.close();
    await closed;
    assert.equal(readFileSync(path, 'utf8'), 'foreign-state');
    assert.equal(existsSync(directory.childPath('retained.sock')), true);
  }
  private readonly endpointToken = new CapabilityToken<FixtureEndpoint>('host.sandbox.control', ProviderV4Schemas.version, new FixtureEndpointAdapter());
  async adoption(): Promise<void> {
    const authority = new UnixPeerFixture();
    const directory = mkdtempSync(join(tmpdir(), 'socket-adopt-'));
    const scope = await this.raceScope(authority, directory);
    const lease = await scope.acquire(this.endpointToken);
    try {
      await assert.rejects(lease.value.start());
      this.closedDescriptor(ReplacedSocketFixture.descriptor);
      assert.equal(readFileSync(join(directory, 'control.sock'), 'utf8'), 'foreign-before-adoption');
    } finally {
      await lease.release();
      await scope.dispose();
    }
    assert.equal(readFileSync(join(directory, 'control.sock'), 'utf8'), 'foreign-before-adoption');
    assert.equal(existsSync(join(directory, 'retained.sock')), true);
  }
  private closedDescriptor(fd: number): void {
    try {
      const stat = fstatSync(fd);
      assert(stat.isSocket());
      closeSync(fd);
      assert.fail('Unadopted listener descriptor leaked');
    } catch (error) {
      if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'EBADF') return;
      throw error;
    }
  }
  private async raceScope(authority: UnixPeerFixture, directory: string): Promise<CordisScope> {
    const registrations = this.raceRegistrations(authority, directory);
    const selections = [];
    for (const registration of registrations) selections.push({ scopeId: this.authority.scopeId, capability: registration.token.id, providerId: ProviderV4Schemas.declaration.parse(registration.declaration).id });
    return CordisScope.start({ registrations, selections }, this.authority);
  }
  private raceRegistrations(authority: UnixPeerFixture, directory: string): ProviderRegistration[] {
    const path = realpathSync('/lib/x86_64-linux-gnu/libc.so.6');
    const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
    const artifact = { kind: 'bundled' as const, identity: 'fixture-only-native-adoption-race' };
    const configuration = { scope: authority.scope, endpointDirectory: directory, authorityFile: authority.authorityFile, configurationDigest: 'd'.repeat(64) };
    return [
      { ...this.registration(path, sha256), plugin: ReplacedSocketFixture },
      { plugin: UnusedKataFixture, token: KataSandboxToken, declaration: UnusedKataFixture.declaration, configuration: {}, artifact },
      { plugin: SandboxControlPlugin, token: this.endpointToken, declaration: SandboxControlPlugin.declaration, configuration, artifact },
    ];
  }
  private readonly authority = {
    scopeId: 'installation:fixture:host',
    target: 'deployment' as const,
    principalId: 'uid:' + process.getuid!(),
    resourceScope: 'installation:fixture',
  };
  private async native(): Promise<CordisScope> {
    const path = realpathSync('/lib/x86_64-linux-gnu/libc.so.6');
    const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
    const registration = this.registration(path, sha256);
    const selections = [
      {
        scopeId: this.authority.scopeId,
        capability: UnixSocketToken.id,
        providerId: UnixSocketPlugin.declaration.id,
      },
    ];
    return CordisScope.start({ registrations: [registration], selections }, this.authority);
  }
  private registration(path: string, sha256: string): ProviderRegistration {
    return {
      plugin: UnixSocketPlugin,
      token: UnixSocketToken,
      declaration: UnixSocketPlugin.declaration,
      configuration: { path, sha256 },
      artifact: { kind: 'bundled', identity: 'fixture-native-unix-io' },
    };
  }
}
const suite = new SandboxChannelIntegration();
test(
  'integration: real private Unix client binds matching replies and refuses substituted request identity',
  suite.peer.bind(suite),
);
test(
  'integration: private sandbox client denies foreign grant scope and public authority before connection',
  suite.scope.bind(suite),
);
test(
  'integration: default native Unix descriptor ownership preserves foreign pathname on listener close',
  suite.descriptor.bind(suite),
);

test(
  'integration: private sandbox client refuses duplicate and unsafe frames without leaking provider output',
  suite.unsafeFrames.bind(suite),
);
test(
  'integration: cancelled private sandbox admission creates no peer connection',
  suite.cancelled.bind(suite),
);

test('integration: native endpoint closes an unadopted descriptor after socket identity substitution', suite.adoption.bind(suite));

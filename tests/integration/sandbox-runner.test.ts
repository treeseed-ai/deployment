import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, chmodSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CapacitySchemas,
  CapacityChannelSchemas,
  SandboxRunnerSchemas,
  SandboxRunnerBinding,
  type SandboxRunnerClient,
  type SandboxRunnerRequest,
  type CapacityReadiness,
} from '@treeseed-cordis/sdk';
import * as Deployment from '@treeseed-cordis/deployment/sandbox-control';
interface RunnerClientConstructor {
  new (input: unknown): SandboxRunnerClient;
}
/** Explicit protocol peer only, not an Agent root, host backend or Kata evidence. */
class RunnerPeerFixture {
  readonly directory = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-runner-peer-')));
  readonly authorityFile = join(this.directory, 'authority.json');
  readonly scope = {
    installationId: 'installation:fixture',
    serviceId: 'worker',
    providerGeneration: 'a'.repeat(64),
    serviceGeneration: 'b'.repeat(64),
  };
  readonly capacityScope = {
    installationId: this.scope.installationId,
    installationDirectory: this.directory,
    capacityProviderId: 'fixture.provider',
    project: 'fixture.project',
    platformProfile: 'fixture.default',
    workerId: 'fixture.worker',
  };
  readonly generation = {
    compositionGeneration: 'c'.repeat(64),
    processGeneration: 'd'.repeat(64),
  };
  private readonly server = createServer(this.connected.bind(this));
  private readonly buffers = new Map<Socket, Buffer>();
  connections = 0;
  constructor(readonly mode: string) {
    this.publish();
  }
  private runnerGrant() {
    return {
      schemaVersion: 'treeseed.sandbox-runner-grant/v1',
      id: 'grant:runner',
      revision: 1,
      scope: this.mode === 'foreign-grant' ? { ...this.scope, serviceId: 'foreign' } : this.scope,
      capacityScope:
        this.mode === 'foreign-capacity'
          ? { ...this.capacityScope, workerId: 'foreign' }
          : this.capacityScope,
      state: this.mode === 'revoked' ? 'revoked' : 'granted',
      expiresAtEpochMs: this.mode === 'expired' ? Date.now() - 1 : Date.now() + 60000,
      operations: ['ready'],
    };
  }
  private publish(revoke = false): void {
    const runnerGrant = this.runnerGrant();
    if (revoke) runnerGrant.state = 'revoked';
    const record = {
      credential: 'e'.repeat(64),
      grant: {
        schemaVersion: 'treeseed.sandbox-grant/v1',
        id: 'grant:control',
        revision: 1,
        scope: this.scope,
        state: this.mode === 'parent-revoked' ? 'revoked' : 'granted',
        expiresAtEpochMs: this.mode === 'parent-expired' ? Date.now() - 1 : Date.now() + 60000,
        operations: ['ready'],
      },
      ...(this.mode === 'absent' ? {} : { runnerGrant }),
    };
    writeFileSync(this.authorityFile, JSON.stringify(record), { mode: 0o600 });
  }
  async start(): Promise<void> {
    const ready = once(this.server, 'listening');
    this.server.listen(join(this.directory, 'control.sock'));
    await ready;
    chmodSync(join(this.directory, 'control.sock'), 0o600);
  }
  private connected(socket: Socket): void {
    this.connections++;
    this.buffers.set(socket, Buffer.alloc(0));
    socket.on('data', this.data.bind(this, socket));
    socket.once('close', this.closed.bind(this, socket));
  }
  private closed(socket: Socket): void {
    this.buffers.delete(socket);
  }
  private data(socket: Socket, bytes: Buffer): void {
    const before = this.buffers.get(socket)!;
    if (before.length + bytes.length > 65536) {
      socket.destroy();
      return;
    }
    const combined = Buffer.concat([before, bytes]);
    this.buffers.set(socket, combined);
    if (combined.includes(10)) this.answer(socket, combined);
  }
  private answer(socket: Socket, bytes: Buffer): void {
    assert.equal(bytes.indexOf(10), bytes.length - 1);
    const frame = JSON.parse(bytes.toString());
    assert.equal(frame.credential, 'e'.repeat(64));
    const request = SandboxRunnerSchemas.request.parse(frame.request);
    if (this.mode === 'silent') return;
    if (this.mode === 'late-revoked') this.publish(true);
    socket.end(this.encoded(this.response(request)) + '\n');
  }
  private ready(): CapacityReadiness {
    return CapacitySchemas.readiness.parse({
      schemaVersion: 'treeseed.capacity-readiness/v1',
      role: 'runner',
      scope: this.capacityScope,
      generation:
        this.mode === 'generation'
          ? { ...this.generation, processGeneration: 'f'.repeat(64) }
          : this.generation,
      ready: true,
      blockers: [],
    });
  }
  private guestResponse(request: SandboxRunnerRequest) {
    const ready = this.ready();
    return CapacityChannelSchemas.response.parse({
      schemaVersion: request.frame.schemaVersion,
      requestId: request.requestId,
      role: 'runner',
      operation: 'ready',
      scope: ready.scope,
      generation: ready.generation,
      success: true,
      result: ready,
      problem: null,
    });
  }
  private response(request: SandboxRunnerRequest): object {
    return {
      schemaVersion: request.schemaVersion,
      requestId: this.mode === 'foreign' ? 'foreign' : request.requestId,
      scope: request.scope,
      sandboxId: request.sandboxId,
      success: true,
      result: this.guestResponse(request),
      problem: null,
    };
  }
  private encoded(response: object): string {
    if (this.mode === 'secret') return '{"problem":"PRIVATE_RUNNER_CANARY"}';
    const text = JSON.stringify(response);
    if (this.mode === 'duplicate')
      return text.replace('"success":true', '"success":true,"success":true');
    if (this.mode === 'extra') return text + '\n' + text;
    return text;
  }
  request(): SandboxRunnerRequest {
    const requestId = 'ready.' + randomUUID();
    const frame = {
      schemaVersion: 'treeseed.capacity-channel/v1',
      requestId,
      scope: this.capacityScope,
      role: 'runner',
      operation: 'ready',
      expectedGeneration: this.generation,
      parameters: {},
    };
    return SandboxRunnerSchemas.request.parse({
      schemaVersion: 'treeseed.sandbox-runner/v1',
      requestId,
      scope: this.scope,
      sandboxId: 'sandbox-' + randomUUID(),
      frame,
    });
  }
  async close(): Promise<void> {
    for (const socket of this.buffers.keys()) socket.destroy();
    if (this.server.listening) {
      const closed = once(this.server, 'close');
      this.server.close();
      await closed;
    }
    rmSync(this.directory, { recursive: true, force: true });
  }
}
class RunnerSocketIntegration {
  private readonly localDenials = [
    'absent',
    'revoked',
    'expired',
    'parent-revoked',
    'parent-expired',
    'foreign-grant',
    'foreign-capacity',
    'cancel',
  ];
  private async exchange(fixture: RunnerPeerFixture, signal: AbortSignal) {
    const Client = Reflect.get(Deployment, 'SandboxRunnerSocketClient') as RunnerClientConstructor;
    assert.equal(typeof Client, 'function', 'public private runner client missing');
    const request = fixture.request();
    const response = await new Client({
      endpointDirectory: fixture.directory,
      authorityFile: fixture.authorityFile,
      scope: fixture.scope,
      timeoutMs: 200,
    }).exchange(request, signal);
    return SandboxRunnerBinding.assertResponse(response, request);
  }
  async run(mode: string): Promise<void> {
    const fixture = new RunnerPeerFixture(mode);
    try {
      await fixture.start();
      const controller = new AbortController();
      if (mode === 'cancel') controller.abort();
      if (mode === 'valid') {
        const response = await this.exchange(fixture, controller.signal);
        assert.equal(response.success, true);
      } else await assert.rejects(this.exchange(fixture, controller.signal), this.safe.bind(this));
      if (this.localDenials.includes(mode)) assert.equal(fixture.connections, 0);
    } finally {
      await fixture.close();
    }
  }
  private safe(error: unknown): boolean {
    assert(error instanceof Error);
    assert.match(error.message, /^(?:INVALID_)?SANDBOX_[A-Z_]+$/);
    assert(!error.message.includes('PRIVATE_RUNNER_CANARY'));
    return true;
  }
}
const suite = new RunnerSocketIntegration();
test(
  'integration: real private runner socket validates both SDK envelopes and exact generations',
  suite.run.bind(suite, 'valid'),
);
for (const mode of [
  'foreign',
  'generation',
  'duplicate',
  'extra',
  'secret',
  'late-revoked',
  'silent',
  'absent',
  'revoked',
  'expired',
  'parent-revoked',
  'parent-expired',
  'foreign-grant',
  'foreign-capacity',
  'cancel',
])
  test(
    'integration: private runner socket rejects ' +
      mode +
      ' without unsafe output or authority fallback',
    suite.run.bind(suite, mode),
  );

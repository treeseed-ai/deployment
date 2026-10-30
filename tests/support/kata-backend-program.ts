import { KataWorkloadFixture } from './kata-workload-fixture.js';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  chmodSync,
  realpathSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import {
  CanonicalJson,
  type CapabilityToken,
  type NativeDescriptorClass,
} from '@treeseed-cordis/sdk';
import {
  CordisScope,
  type ProviderLease,
  type ProviderRegistration,
  type CompositionDescriptor,
} from '@treeseed-cordis/sdk/runtime';
import * as deployment from '@treeseed-cordis/deployment/sandbox';

interface SandboxEvidence {
  id: string;
  resourceName: string;
  kernel: string;
  inspectionDigest: string;
  hypervisor: { pid: number; startTime: string };
  assignment: { assignmentId: string; environmentId: string } | null;
}
interface Backend {
  assign(
    id: string,
    assignmentId: string,
    environmentId: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  execute(
    id: string,
    phase: 'setup' | 'verification',
    signal: AbortSignal,
  ): Promise<{ exitCode: number; outputBytes: number }>;
  create(id: string, signal: AbortSignal): Promise<SandboxEvidence>;
  inspect(id: string, signal: AbortSignal): Promise<SandboxEvidence>;
  destroy(
    id: string,
    signal: AbortSignal,
  ): Promise<{ id: string; destroyed: true; inspectionDigest: string }>;
  close(): Promise<void>;
}
interface BackendConstructor {
  open(configuration: unknown): Promise<Backend>;
}

/** Qualification-only daemon fixture; production default construction remains in Deployment. */
export class PrivateKataFixture {
  readonly directory = PrivateKataFixture.qualifiedDirectory();
  readonly socket = join(this.directory, 'containerd.sock');
  readonly workloads = new KataWorkloadFixture(this.directory);
  readonly namespaceScope = {
    installationId: 'fixture-' + randomUUID(),
    serviceId: 'worker',
    providerGeneration: 'a'.repeat(64),
  };
  readonly namespace = 'cordis-sandbox-' + CanonicalJson.digest(this.namespaceScope).slice(0, 24);
  private daemon: ChildProcess | null = null;
  private log: number | null = null;
  private mode: 'environment' | 'task-options' = 'environment';
  private static qualifiedDirectory(): string {
    if (
      typeof Bun === 'undefined' ||
      process.platform !== 'linux' ||
      process.arch !== 'x64' ||
      process.getuid?.() !== 0 ||
      process.env.GITHUB_ACTIONS !== 'true' ||
      process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      !process.env.RUNNER_TEMP?.startsWith('/home/runner/')
    )
      throw new Error('KATA_QUALIFICATION_REQUIRED');
    return mkdtempSync('/run/cordis-backend-');
  }
  private readonly daemonArguments = [
    '--config',
    join(this.directory, 'config.toml'),
    '--root',
    join(this.directory, 'root'),
    '--state',
    join(this.directory, 'state'),
    '--address',
    this.socket,
  ];
  static hash(file: string): string {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  }
  static startTime(pid: number): string {
    const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
    return stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/)[19]!;
  }
  async start(mode: 'environment' | 'task-options' = 'environment'): Promise<void> {
    this.mode = mode;
    const config = join(this.directory, 'config.toml');
    writeFileSync(config, 'version = 2\ndisabled_plugins = ["io.containerd.grpc.v1.cri"]\n', {
      mode: 0o600,
    });
    this.log = openSync(join(this.directory, 'daemon.log'), 'wx', 0o600);
    this.daemon = spawn('/usr/bin/containerd', this.daemonArguments, {
      stdio: ['ignore', this.log, this.log],
      env: this.environment(),
    });
    this.daemon.on('error', this.failed.bind(this));
    await this.ready();
    chmodSync(this.socket, 0o600);
  }
  private environment(): NodeJS.ProcessEnv {
    const environment = { ...process.env };
    if (this.mode === 'task-options') delete environment.KATA_CONF_FILE;
    else environment.KATA_CONF_FILE = realpathSync(process.env.KATA_CONF_FILE!);
    return environment;
  }
  private failed(error: Error): void {
    throw error;
  }
  private async ready(): Promise<void> {
    for (let count = 0; count < 200; count++) {
      assert.equal(this.daemon!.exitCode, null);
      const result = spawnSync('/usr/bin/ctr', ['--address', this.socket, 'version'], {
        timeout: 1000,
      });
      if (result.status === 0) return;
      await Bun.sleep(25);
    }
    throw new Error('private daemon readiness failed');
  }
  private arguments(args: string[]): string[] {
    return ['--address', this.socket, '--namespace', this.namespace, ...args];
  }
  run(args: string[]): string {
    const result = spawnSync('/usr/bin/ctr', this.arguments(args), {
      encoding: 'utf8',
      timeout: 120000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  async guestStarted(name: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const command = this.arguments([
        'tasks',
        'exec',
        '--exec-id',
        'marker-' + randomUUID(),
        name,
        '/bin/test',
        '-f',
        '/tmp/cordis-env-started',
      ]);
      const child = spawn('/usr/bin/ctr', command, { stdio: 'ignore' });
      const result = await once(child, 'close');
      if (result[0] === 0) return;
      await delay(50);
    }
    throw new Error('guest setup did not start');
  }
  async configuration(): Promise<unknown> {
    const scope = this.namespaceScope;
    const custody = join(this.directory, 'custody');
    mkdirSync(custody, { mode: 0o700 });
    return {
      scope,
      custody,
      endpointDirectory: this.directory,
      daemon: this.daemonIdentity(),
      client: this.file('/usr/bin/ctr'),
      runtime: this.runtime(),
      image:
        'docker.io/library/busybox@sha256:66a6306db78bf2dbf3487f293aa8d6990d8e506fdffab9cc43fe422becf886e4',
      workloads: this.workloads.prepare(
        'docker.io/library/busybox@sha256:66a6306db78bf2dbf3487f293aa8d6990d8e506fdffab9cc43fe422becf886e4',
      ),
    };
  }
  private file(path: string): object {
    return { path: realpathSync(path), sha256: PrivateKataFixture.hash(path) };
  }
  private runtime(): object {
    return {
      configurationMode: this.mode,
      version: '4.1.0',
      archive: this.archive(),
      guestKernel: '6.18.35',
      shim: this.file('/opt/kata/runtime-rs/bin/containerd-shim-kata-v2'),
      hypervisor: this.file('/opt/kata/bin/qemu-system-x86_64'),
      configuration: this.file(process.env.KATA_CONF_FILE!),
    };
  }
  private archive(): object {
    const path = '/opt/kata/kata-static-4.1.0-amd64.tar.zst';
    return {
      path,
      size: 969565384,
      sha256: '3dc6b69c4acb787b967b04b64599a20d02a8beb1a8eaab3084110df9d0b08c96',
    };
  }
  private daemonIdentity(): object {
    const pid = this.daemon!.pid!;
    return {
      pid,
      startTime: PrivateKataFixture.startTime(pid),
      commandDigest: PrivateKataFixture.hash('/proc/' + pid + '/cmdline'),
    };
  }
  async stop(): Promise<void> {
    if (this.daemon?.exitCode === null) {
      this.daemon.kill('SIGTERM');
      for (let count = 0; count < 200 && this.daemon.exitCode === null; count++)
        await Bun.sleep(25);
      assert.notEqual(this.daemon.exitCode, null, 'private daemon must stop');
    }
    if (this.log !== null) closeSync(this.log);
  }
}

class KataBackendProgram {
  private scope: CordisScope | null = null;
  private lease: ProviderLease<Backend & { ready(): Promise<void> }> | null = null;
  private host(): void {
    assert.equal(process.env.GITHUB_ACTIONS, 'true');
    assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
    assert(process.env.RUNNER_TEMP?.startsWith('/home/runner/'));
    assert.equal(process.getuid?.(), 0);
  }
  async run(): Promise<void> {
    if (process.argv[2] === '-name') return this.holdProcess();
    if (process.argv[2] === '--interface') return this.interface();
    this.host();
    await this.qualify();
  }
  private async holdProcess(): Promise<void> {
    process.stdout.write('process-observer-fixture-ready\n');
    await delay(30000);
  }
  private async qualify(): Promise<void> {
    const fixture = new PrivateKataFixture();
    const failures: unknown[] = [];
    try {
      await this.exercise(fixture);
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.disposeNative();
    } catch (error) {
      failures.push(error);
    }
    try {
      await fixture.stop();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, 'Kata backend qualification failed');
    process.stdout.write('owned-kata-backend-ok\n');
  }
  private async interface(): Promise<void> {
    const constructor = Reflect.get(
      deployment,
      'KataSandboxBackend',
    ) as unknown as BackendConstructor;
    assert.equal(typeof constructor, 'function', 'production Kata backend must exist');
    await assert.rejects(constructor.open({}), {
      message: 'KATA_CONFIGURATION_INVALID',
    });
    const prototype = Reflect.get(deployment, 'KataSandboxBackend').prototype;
    assert.equal(
      typeof Reflect.get(prototype, 'assign'),
      'function',
      'bounded assignment must exist',
    );
    assert.equal(
      typeof Reflect.get(prototype, 'execute'),
      'function',
      'guest entrypoint execution must exist',
    );
    process.stdout.write('kata-interface-ok\n');
  }
  private async exercise(fixture: PrivateKataFixture): Promise<void> {
    const backend = await this.prepare(fixture);
    const failures: unknown[] = [];
    try {
      await this.lifecycle(backend);
      await this.failedGuest(backend, 'environment:failed');
      await this.failedGuest(backend, 'environment:deadline');
      await this.failedGuest(backend, 'environment:output');
      await this.cancelGuest(backend, fixture);
      fixture.workloads.canaries();
    } catch (error) {
      failures.push(error);
    }
    try {
      await backend.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, 'Backend lifecycle or cleanup failed');
    assert.equal(fixture.run(['tasks', 'list', '--quiet']), '');
    assert.equal(fixture.run(['containers', 'list', '--quiet']), '');
  }
  private async prepare(fixture: PrivateKataFixture): Promise<Backend> {
    await fixture.start();
    const configuration = await fixture.configuration();
    const constructor = Reflect.get(
      deployment,
      'KataSandboxBackend',
    ) as unknown as BackendConstructor;
    assert.equal(typeof constructor, 'function', 'production Kata backend must exist');
    await this.archiveAdmission(constructor, configuration);
    this.pull(fixture, configuration);
    await this.scriptCanary(constructor, configuration, fixture.directory);
    return this.native(configuration, fixture.namespaceScope.installationId);
  }
  private pull(fixture: PrivateKataFixture, configuration: unknown): void {
    const image = Reflect.get(configuration as object, 'image') as string;
    fixture.run([
      'images',
      'pull',
      '--local',
      '--platform',
      'linux/amd64',
      '--snapshotter',
      'native',
      image,
    ]);
  }
  private async archiveAdmission(
    constructor: BackendConstructor,
    configuration: unknown,
  ): Promise<void> {
    const value = configuration as { runtime: Record<string, unknown>; custody: string };
    const archive = { ...(value.runtime.archive as object), sha256: '0'.repeat(64) };
    const input = { ...value, runtime: { ...value.runtime, archive } };
    await assert.rejects(constructor.open(input), { message: 'KATA_RUNTIME_ARCHIVE_INVALID' });
    assert.deepEqual(readdirSync(value.custody), []);
  }
  private async native(configuration: unknown, installationId: string): Promise<Backend> {
    const token = Reflect.get(deployment, 'KataSandboxToken') as unknown as CapabilityToken<
      Backend & { ready(): Promise<void> }
    >;
    const scopeId = 'installation:' + installationId + ':host';
    const registration = this.registration(configuration, token);
    this.scope = await CordisScope.start(this.composition(scopeId, registration, token), {
      scopeId,
      target: 'deployment',
      principalId: 'uid:0',
      resourceScope: installationId,
    });
    this.lease = await this.scope.acquire(token);
    await this.lease.value.ready();
    return this.lease.value;
  }
  private composition(
    scopeId: string,
    registration: ProviderRegistration,
    token: CapabilityToken,
  ): CompositionDescriptor {
    return {
      registrations: [registration],
      selections: [{ scopeId, capability: token.id, providerId: 'deployment.sandbox.kata' }],
    };
  }
  private registration(configuration: unknown, token: CapabilityToken): ProviderRegistration {
    const plugin = Reflect.get(deployment, 'KataSandboxPlugin') as NativeDescriptorClass;
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
    return {
      plugin: plugin as unknown as ProviderRegistration['plugin'],
      token,
      declaration: plugin.declaration,
      configuration,
      artifact: { kind: 'bundled', identity: metadata.name + '@' + metadata.version },
    };
  }
  private async disposeNative(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.lease?.release();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.scope?.dispose();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, 'Native host disposal failed');
  }
  private async scriptCanary(
    constructor: BackendConstructor,
    configuration: unknown,
    directory: string,
  ): Promise<void> {
    const path = join(directory, 'not-a-runtime.sh');
    writeFileSync(path, '#!/bin/sh\nprintf canary > "$0.executed"\n', {
      mode: 0o700,
    });
    const invalid = {
      ...(configuration as object),
      client: { path, sha256: PrivateKataFixture.hash(path) },
    };
    await assert.rejects(constructor.open(invalid), {
      message: 'KATA_EXECUTABLE_INVALID',
    });
    assert.equal(existsSync(path + '.executed'), false);
  }
  private async lifecycle(backend: Backend): Promise<void> {
    const signal = new AbortController().signal;
    const id = 'sandbox-' + randomUUID();
    const failures: unknown[] = [];
    try {
      await this.warm(backend, id, signal);
    } catch (error) {
      failures.push(error);
    }
    try {
      assert.equal((await backend.destroy(id, signal)).destroyed, true);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(failures, 'Warm guest or scoped destruction failed');
    await assert.rejects(backend.inspect(id, signal));
    await assert.rejects(backend.create(id, signal));
    await assert.rejects(backend.destroy('sandbox-' + randomUUID(), signal));
  }
  private async failedGuest(backend: Backend, environmentId: string): Promise<void> {
    const signal = new AbortController().signal;
    const id = 'sandbox-' + randomUUID();
    await backend.create(id, signal);
    try {
      await backend.assign(id, 'assignment:negative', environmentId, signal);
      await assert.rejects(backend.execute(id, 'setup', signal), this.safeError.bind(this));
      await assert.rejects(backend.execute(id, 'verification', signal));
      await assert.rejects(backend.execute(id, 'setup', signal));
    } finally {
      assert.equal((await backend.destroy(id, signal)).destroyed, true);
    }
  }
  private async cancelGuest(backend: Backend, fixture: PrivateKataFixture): Promise<void> {
    const signal = new AbortController().signal;
    const controller = new AbortController();
    const id = 'sandbox-' + randomUUID();
    const evidence = await backend.create(id, signal);
    await backend.assign(id, 'assignment:cancel', 'environment:slow', signal);
    const pending = Promise.allSettled([backend.execute(id, 'setup', controller.signal)]);
    try {
      await fixture.guestStarted(evidence.resourceName);
      controller.abort();
      const result = (await pending)[0]!;
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') this.safeError(result.reason);
      await assert.rejects(backend.execute(id, 'verification', signal));
    } finally {
      controller.abort();
      await pending;
      assert.equal((await backend.destroy(id, signal)).destroyed, true);
    }
  }
  private safeError(error: unknown): boolean {
    assert(error instanceof Error);
    assert.match(error.message, /^KATA_[A-Z_]+$/);
    assert(!error.message.includes('guest-output-canary'));
    return true;
  }
  private async preparation(backend: Backend, id: string, signal: AbortSignal): Promise<void> {
    await assert.rejects(backend.execute(id, 'setup', signal));
    const assigned = await backend.assign(id, 'assignment:fixture', 'environment:good', signal);
    assert.deepEqual(
      await backend.assign(id, 'assignment:fixture', 'environment:good', signal),
      assigned,
    );
    await assert.rejects(backend.assign(id, 'assignment:foreign', 'environment:good', signal));
    await assert.rejects(backend.execute(id, 'verification', signal));
    const setup = await backend.execute(id, 'setup', signal);
    assert.equal(setup.exitCode, 0);
    assert(!JSON.stringify(setup).includes('guest-output-canary'));
    assert.deepEqual(await backend.execute(id, 'setup', signal), setup);
    assert.equal((await backend.execute(id, 'verification', signal)).exitCode, 0);
    assert.equal(
      (await backend.inspect(id, signal)).assignment?.assignmentId,
      'assignment:fixture',
    );
  }

  private async warm(backend: Backend, id: string, signal: AbortSignal): Promise<void> {
    const created = await backend.create(id, signal);
    await assert.rejects(backend.close());
    const inspected = await backend.inspect(id, signal);
    assert(created.hypervisor.pid > 0);
    assert.equal(
      PrivateKataFixture.startTime(created.hypervisor.pid),
      created.hypervisor.startTime,
    );
    assert.equal(created.id, id);
    assert.equal(created.kernel, inspected.kernel);
    assert.equal(created.inspectionDigest, inspected.inspectionDigest);
    assert.equal(inspected.assignment, null);
    await this.preparation(backend, id, signal);
  }
}
if (import.meta.main) await new KataBackendProgram().run();

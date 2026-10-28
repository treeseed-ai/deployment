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
} from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  CanonicalJson,
  type CapabilityToken,
  type NativeDescriptorClass,
} from '@treeseed-cordis/sdk';
import {
  CordisScope,
  type ProviderLease,
  type ProviderRegistration,
} from '@treeseed-cordis/sdk/runtime';
import * as deployment from '@treeseed-cordis/deployment/sandbox';

interface SandboxEvidence {
  id: string;
  resourceName: string;
  kernel: string;
  inspectionDigest: string;
}
interface Backend {
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
class PrivateKataFixture {
  readonly directory = mkdtempSync(join(process.env.RUNNER_TEMP!, 'cordis-backend-'));
  readonly socket = join(this.directory, 'containerd.sock');
  readonly namespaceScope = {
    installationId: 'fixture-' + randomUUID(),
    serviceId: 'worker',
    providerGeneration: 'a'.repeat(64),
  };
  readonly namespace = 'cordis-sandbox-' + CanonicalJson.digest(this.namespaceScope).slice(0, 24);
  private daemon: ChildProcess | null = null;
  private log: number | null = null;
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
  async start(): Promise<void> {
    const config = join(this.directory, 'config.toml');
    writeFileSync(config, 'version = 2\ndisabled_plugins = ["io.containerd.grpc.v1.cri"]\n', {
      mode: 0o600,
    });
    this.log = openSync(join(this.directory, 'daemon.log'), 'wx', 0o600);
    this.daemon = spawn('/usr/bin/containerd', this.daemonArguments, {
      stdio: ['ignore', this.log, this.log],
      env: { ...process.env, KATA_CONF_FILE: realpathSync(process.env.KATA_CONF_FILE!) },
    });
    this.daemon.on('error', this.failed.bind(this));
    await this.ready();
    chmodSync(this.socket, 0o600);
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
  run(args: string[]): string {
    const result = spawnSync(
      '/usr/bin/ctr',
      ['--address', this.socket, '--namespace', this.namespace, ...args],
      { encoding: 'utf8', timeout: 120000 },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
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
      runtime: {
        version: '4.1.0',
        guestKernel: '6.18.35',
        shim: this.file('/opt/kata/runtime-rs/bin/containerd-shim-kata-v2'),
        configuration: this.file(process.env.KATA_CONF_FILE!),
      },
      image:
        'docker.io/library/busybox@sha256:66a6306db78bf2dbf3487f293aa8d6990d8e506fdffab9cc43fe422becf886e4',
    };
  }
  private file(path: string): object {
    return { path: realpathSync(path), sha256: PrivateKataFixture.hash(path) };
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
    if (process.argv[2] === '--interface') return this.interface();
    this.host();
    await this.qualify();
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
    const constructor = Reflect.get(deployment, 'KataSandboxBackend') as BackendConstructor;
    assert.equal(typeof constructor, 'function', 'production Kata backend must exist');
    await assert.rejects(constructor.open({}), { message: 'KATA_CONFIGURATION_INVALID' });
    process.stdout.write('kata-interface-ok\n');
  }
  private async exercise(fixture: PrivateKataFixture): Promise<void> {
    const backend = await this.prepare(fixture);
    const failures: unknown[] = [];
    try {
      await this.lifecycle(backend);
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
    const constructor = Reflect.get(deployment, 'KataSandboxBackend') as BackendConstructor;
    assert.equal(typeof constructor, 'function', 'production Kata backend must exist');
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
    await this.scriptCanary(constructor, configuration, fixture.directory);
    return this.native(configuration, fixture.namespaceScope.installationId);
  }
  private async native(configuration: unknown, installationId: string): Promise<Backend> {
    const token = Reflect.get(deployment, 'KataSandboxToken') as CapabilityToken<
      Backend & { ready(): Promise<void> }
    >;
    const scopeId = 'installation:' + installationId + ':host';
    const registration = this.registration(configuration, token);
    this.scope = await CordisScope.start(
      {
        registrations: [registration],
        selections: [{ scopeId, capability: token.id, providerId: 'deployment.sandbox.kata' }],
      },
      { scopeId, target: 'deployment', principalId: 'uid:0', resourceScope: installationId },
    );
    this.lease = await this.scope.acquire(token);
    await this.lease.value.ready();
    return this.lease.value;
  }
  private registration(configuration: unknown, token: CapabilityToken): ProviderRegistration {
    const plugin = Reflect.get(deployment, 'KataSandboxPlugin') as NativeDescriptorClass;
    return {
      plugin: plugin as unknown as ProviderRegistration['plugin'],
      token,
      declaration: plugin.declaration,
      configuration,
      artifact: { kind: 'bundled', identity: '@treeseed-cordis/deployment@0.0.0-cordis.80' },
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
    writeFileSync(path, '#!/bin/sh\nprintf canary > "$0.executed"\n', { mode: 0o700 });
    const invalid = {
      ...(configuration as object),
      client: { path, sha256: PrivateKataFixture.hash(path) },
    };
    await assert.rejects(constructor.open(invalid), { message: 'KATA_EXECUTABLE_INVALID' });
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
  private async warm(backend: Backend, id: string, signal: AbortSignal): Promise<void> {
    const created = await backend.create(id, signal);
    await assert.rejects(backend.close());
    const inspected = await backend.inspect(id, signal);
    assert.equal(created.id, id);
    assert.equal(created.kernel, inspected.kernel);
    assert.equal(created.inspectionDigest, inspected.inspectionDigest);
  }
}
if (import.meta.main) await new KataBackendProgram().run();

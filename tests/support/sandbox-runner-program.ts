import assert from 'node:assert/strict';
import {
  mkdirSync,
  copyFileSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  statSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  CapacitySchemas,
  CapacityChannelSchemas,
  CanonicalJson,
  SandboxRunnerSchemas,
  SandboxRunnerBinding,
  type CapacityProcessGeneration,
  type CapacityReadiness,
  type SandboxRunnerClient,
  type SandboxRunnerRequest,
  type SandboxControlScope,
} from '@treeseed-cordis/sdk';
import * as Deployment from '@treeseed-cordis/deployment/sandbox-control';
import { PrivateKataFixture } from './kata-backend-program.js';
interface RunnerClientConstructor {
  new (configuration: unknown): SandboxRunnerClient;
}
class HostedRunnerChannel {
  private readonly fixture = new PrivateKataFixture();
  private readonly endpointDirectory = join(this.fixture.directory, 'worker-control');
  private readonly authorityFile = join(this.fixture.directory, 'worker-authority.json');
  private readonly credential = randomBytes(32).toString('hex');
  private readonly scope: SandboxControlScope = {
    ...this.fixture.namespaceScope,
    serviceGeneration: 'e'.repeat(64),
  };
  private readonly capacityScope = CapacitySchemas.scope.parse({
    installationId: this.scope.installationId,
    installationDirectory: this.fixture.directory,
    capacityProviderId: 'fixture.provider',
    project: 'fixture.project',
    platformProfile: 'fixture.default',
    workerId: 'fixture.worker',
  });
  private readonly image =
    'docker.io/library/ubuntu@sha256:157dc3d6e4a3e4f2c68d12df9df9ed6e808b59af6d4c3757b432b4f519916725';
  private application: Deployment.SandboxControlApplication | null = null;
  constructor(private readonly Client: RunnerClientConstructor) {}
  async run(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.exercise();
    } catch (error) {
      failures.push(error);
    }
    for (const operation of [this.close.bind(this), this.fixture.stop.bind(this.fixture)]) {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Private runner qualification failed');
    assert(!existsSync(join(this.endpointDirectory, 'control.sock')));
    process.stdout.write('sandbox-runner-kata-ok\n');
  }
  private async close(): Promise<void> {
    await this.application?.close();
  }
  private async exercise(): Promise<void> {
    await this.fixture.start();
    const host = await this.host();
    mkdirSync(this.endpointDirectory, { mode: 0o700 });
    this.publish(this.authority());
    this.application = await Deployment.SandboxControlApplication.start(this.configuration(host));
    await this.guest();
    assert.equal(this.fixture.run(['tasks', 'list', '--quiet']), '');
    assert.equal(this.fixture.run(['containers', 'list', '--quiet']), '');
  }
  private async host(): Promise<object> {
    const original = await this.fixture.configuration();
    const directory = join(this.fixture.directory, 'runner-artifacts');
    mkdirSync(directory, { mode: 0o700 });
    copyFileSync('vendor/agent-guest.tgz', join(directory, 'agent.tgz'));
    chmodSync(join(directory, 'agent.tgz'), 0o600);
    this.fixture.run([
      'images',
      'pull',
      '--local',
      '--platform',
      'linux/amd64',
      '--snapshotter',
      'native',
      this.image,
    ]);
    return {
      ...(original as object),
      workloads: undefined,
      image: this.image,
      guestRuntime: {
        scope: this.capacityScope,
        artifact: this.artifact(directory),
      },
    };
  }
  private artifact(directory: string): object {
    return {
      directory,
      archive: {
        path: 'agent.tgz',
        size: statSync('vendor/agent-guest.tgz').size,
        sha256: '3ebf0257ae72ce921672d016e5bc7530515069a2994ce77660f2c27751f8b0aa',
      },
      package: { name: '@treeseed-cordis/agent', version: '0.0.0-cordis.22' },
    };
  }
  private configuration(host: object): object {
    const path = realpathSync('/lib/x86_64-linux-gnu/libc.so.6');
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
    return {
      scope: this.scope,
      endpointDirectory: this.endpointDirectory,
      authorityFile: this.authorityFile,
      socketLibrary: { path, sha256: PrivateKataFixture.hash(path) },
      host,
      artifact: {
        package: metadata.name,
        version: metadata.version,
        integrity: CanonicalJson.digest(metadata),
      },
    };
  }
  private authority(): object {
    return {
      credential: this.credential,
      grant: {
        schemaVersion: 'treeseed.sandbox-grant/v1',
        id: 'grant:control',
        revision: 1,
        scope: this.scope,
        state: 'granted',
        expiresAtEpochMs: Date.now() + 180000,
        operations: ['ready', 'create', 'inspect', 'destroy'],
      },
      runnerGrant: {
        schemaVersion: 'treeseed.sandbox-runner-grant/v1',
        id: 'grant:runner',
        revision: 1,
        scope: this.scope,
        capacityScope: this.capacityScope,
        state: 'granted',
        expiresAtEpochMs: Date.now() + 180000,
        operations: ['ready'],
      },
    };
  }
  private publish(record: object): void {
    writeFileSync(this.authorityFile, JSON.stringify(record), { mode: 0o600 });
  }
  private client(): SandboxRunnerClient {
    return new this.Client({
      endpointDirectory: this.endpointDirectory,
      authorityFile: this.authorityFile,
      scope: this.scope,
    });
  }
  private control(): Deployment.SandboxSocketClient {
    return new Deployment.SandboxSocketClient({
      endpointDirectory: this.endpointDirectory,
      authorityFile: this.authorityFile,
      scope: this.scope,
    });
  }
  private request(
    sandboxId: string,
    expectedGeneration: CapacityProcessGeneration | null = null,
  ): SandboxRunnerRequest {
    const requestId = 'ready.' + randomUUID();
    const frame = CapacityChannelSchemas.request.parse({
      schemaVersion: 'treeseed.capacity-channel/v1',
      requestId,
      scope: this.capacityScope,
      role: 'runner',
      operation: 'ready',
      expectedGeneration,
      parameters: {},
    });
    return SandboxRunnerSchemas.request.parse({
      schemaVersion: 'treeseed.sandbox-runner/v1',
      requestId,
      scope: this.scope,
      sandboxId,
      frame,
    });
  }
  private async guest(): Promise<void> {
    const id = 'sandbox-' + randomUUID();
    const signal = new AbortController().signal;
    const failures: unknown[] = [];
    try {
      await this.prepared(id, signal);
    } catch (error) {
      failures.push(error);
    }
    this.publish(this.authority());
    try {
      assert.equal((await this.control().destroy(id, signal)).destroyed, true);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, 'Runner channel guest lifecycle');
    await assert.rejects(this.control().inspect(id, signal));
  }
  private async prepared(id: string, signal: AbortSignal): Promise<void> {
    assert.equal((await this.control().ready(signal)).state, 'available');
    assert.equal((await this.control().create(id, signal)).assignment, null);
    const first = await this.ready(this.request(id), signal);
    const repeated = await this.ready(this.request(id, first.generation), signal);
    assert.deepEqual(repeated.generation, first.generation);
    await this.denials(id, signal);
    assert.equal((await this.control().inspect(id, signal)).assignment, null);
  }
  private async ready(
    request: SandboxRunnerRequest,
    signal: AbortSignal,
  ): Promise<CapacityReadiness> {
    const response = SandboxRunnerBinding.assertResponse(
      await this.client().exchange(request, signal),
      request,
    );
    assert.equal(response.success, true);
    assert(response.success && response.result.success && response.result.operation === 'ready');
    assert.equal(response.result.result.ready, true);
    assert.deepEqual(response.result.result.blockers, []);
    return response.result.result;
  }
  private async denials(id: string, signal: AbortSignal): Promise<void> {
    const wrong = { compositionGeneration: 'f'.repeat(64), processGeneration: 'f'.repeat(64) };
    const response = await this.client().exchange(this.request(id, wrong), signal);
    assert.equal(response.success, false);
    assert(response.problem && /^[A-Z_]+$/.test(response.problem.code));
    for (const state of ['revoked', 'expired', 'absent']) await this.grantDenied(id, state, signal);
    this.publish(this.authority());
  }
  private async grantDenied(id: string, state: string, signal: AbortSignal): Promise<void> {
    const record = this.authority() as {
      credential: string;
      grant: object;
      runnerGrant?: { state: string; expiresAtEpochMs: number };
    };
    if (state === 'absent') delete record.runnerGrant;
    else if (state === 'revoked') record.runnerGrant!.state = 'revoked';
    else record.runnerGrant!.expiresAtEpochMs = Date.now() - 1;
    this.publish(record);
    await assert.rejects(this.client().exchange(this.request(id), signal));
  }
}
class SandboxRunnerProgram {
  async run(): Promise<void> {
    const Client = Reflect.get(Deployment, 'SandboxRunnerSocketClient') as RunnerClientConstructor;
    assert.equal(typeof Client, 'function', 'public private runner client missing');
    if (process.argv[2] === '--interface') {
      assert.throws(this.invalid.bind(this, Client), {
        message: 'INVALID_SANDBOX_CONTROL_CONTRACT',
      });
      process.stdout.write('sandbox-runner-interface-ok\n');
      return;
    }
    assert.equal(process.env.GITHUB_ACTIONS, 'true');
    assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
    assert(process.env.RUNNER_TEMP?.startsWith('/home/runner/'));
    assert.equal(process.getuid?.(), 0);
    await new HostedRunnerChannel(Client).run();
  }
  private invalid(Client: RunnerClientConstructor): void {
    new Client({});
  }
}
if (import.meta.main) await new SandboxRunnerProgram().run();

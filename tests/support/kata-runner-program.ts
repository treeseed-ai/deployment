import assert from 'node:assert/strict';
import { mkdirSync, copyFileSync, chmodSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  CapacitySchemas,
  CapacityChannelSchemas,
  CanonicalJson,
  type CapacityReadiness,
} from '@treeseed-cordis/sdk';
import {
  CordisScope,
  type ProviderLease,
  type CompositionDescriptor,
} from '@treeseed-cordis/sdk/runtime';
import {
  KataSandboxPlugin,
  KataSandboxToken,
  type KataSandboxHost,
} from '@treeseed-cordis/deployment/sandbox';
import { PrivateKataFixture } from './kata-backend-program.js';
/** Actual accepted owner archive is fixture data, never imported or executed on the host. */
class KataRunnerProgram {
  private readonly digest = '3ebf0257ae72ce921672d016e5bc7530515069a2994ce77660f2c27751f8b0aa';
  private readonly image =
    'docker.io/library/ubuntu@sha256:157dc3d6e4a3e4f2c68d12df9df9ed6e808b59af6d4c3757b432b4f519916725';
  private static readonly zero = '0'.repeat(64);
  private static readonly file = { path: '/fixture/unused', sha256: this.zero };
  private static readonly interfaceData = {
    scope: {
      installationId: 'fixture.capacity',
      serviceId: 'worker',
      providerGeneration: this.zero,
    },
    custody: '/fixture/custody',
    endpointDirectory: '/fixture/endpoint',
    daemon: { pid: 1, startTime: '1', commandDigest: this.zero },
    client: this.file,
    runtime: {
      version: '4.1.0',
      guestKernel: '6.12.fixture',
      shim: this.file,
      hypervisor: this.file,
      configuration: this.file,
    },
  };
  private readonly imageArguments = [
    'images',
    'pull',
    '--local',
    '--platform',
    'linux/amd64',
    '--snapshotter',
    'native',
    this.image,
  ];
  private readonly privilegeCheck =
    'found=0; for d in /proc/[0-9]*; do test -r "$d/cmdline" || continue; first=$(tr "\\000" "\\n" < "$d/cmdline" | head -n 1); if test "$first" = /run/treeseed-runner/guest; then grep -Eq "^Uid:[[:space:]]+65532[[:space:]]+65532[[:space:]]+65532[[:space:]]+65532$" "$d/status" || exit 1; grep -Eq "^CapEff:[[:space:]]+0000000000000000$" "$d/status" || exit 1; grep -Eq "^NoNewPrivs:[[:space:]]+1$" "$d/status" || exit 1; found=$((found+1)); fi; done; test "$found" = 1';
  private scope: CordisScope | null = null;
  private lease: ProviderLease<KataSandboxHost> | null = null;
  async run(): Promise<void> {
    if (process.argv[2] === '--interface') return this.interface();
    if (process.argv[2] === '--io-fixture') return new RunnerTransportFixture().run();
    if (process.argv[2] === '--stdin-fixture') return this.inputDigest();
    if (process.argv[2] === '--node-path') {
      process.stdout.write(process.execPath);
      return;
    }
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
    const disposed = await Promise.allSettled([this.disposeNative()]);
    const stopped = await Promise.allSettled([fixture.stop()]);
    for (const result of [...disposed, ...stopped])
      if (result.status === 'rejected') failures.push(result.reason);
    if (failures.length)
      throw new AggregateError(failures, 'Actual guest readiness qualification failed');
    process.stdout.write('kata-native-runner-ok\n');
  }
  private async inputDigest(): Promise<void> {
    const digest = createHash('sha256');
    let size = 0;
    for await (const bytes of process.stdin) {
      size += bytes.length;
      digest.update(bytes);
    }
    process.stdout.write(JSON.stringify({ size, sha256: digest.digest('hex') }));
  }
  private async disposeNative(): Promise<void> {
    await this.lease?.release();
    await this.scope?.dispose();
  }
  private host(): void {
    assert.equal(process.env.GITHUB_ACTIONS, 'true');
    assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
    assert(process.env.RUNNER_TEMP?.startsWith('/home/runner/'));
    assert.equal(process.getuid?.(), 0);
  }
  private scopeData(directory: string) {
    return CapacitySchemas.scope.parse({
      installationId: 'fixture.capacity',
      installationDirectory: directory,
      capacityProviderId: 'fixture.provider',
      project: 'fixture.project',
      platformProfile: 'fixture.default',
      workerId: 'fixture.worker',
    });
  }
  private artifact(directory: string) {
    const source = resolve('vendor/agent-guest.tgz');
    assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), this.digest);
    return {
      directory,
      archive: { path: 'agent.tgz', size: statSync(source).size, sha256: this.digest },
      package: { name: '@treeseed-cordis/agent', version: '0.0.0-cordis.22' },
    };
  }
  private interface(): void {
    const scope = this.scopeData('/fixture/capacity');
    const configuration = {
      ...KataRunnerProgram.interfaceData,
      image: this.image,
      guestRuntime: { scope, artifact: this.artifact('/fixture/artifacts') },
    };
    assert.equal(
      KataSandboxPlugin.Config.safeParse(configuration).success,
      true,
      'exact guest configuration must be admitted',
    );
    process.stdout.write('kata-runner-interface-ok\n');
  }
  private async configuration(fixture: PrivateKataFixture): Promise<unknown> {
    const configuration = await fixture.configuration();
    const directory = join(fixture.directory, 'runner-artifacts');
    mkdirSync(directory, { mode: 0o700 });
    copyFileSync('vendor/agent-guest.tgz', join(directory, 'agent.tgz'));
    chmodSync(join(directory, 'agent.tgz'), 0o600);
    const hostScope = Reflect.get(configuration as object, 'scope');
    const scope = {
      ...this.scopeData(fixture.directory),
      installationId: hostScope.installationId,
    };
    return {
      ...(configuration as object),
      image: this.image,
      guestRuntime: { scope, artifact: this.artifact(directory) },
    };
  }
  private async prepare(fixture: PrivateKataFixture): Promise<KataSandboxHost> {
    await fixture.start();
    const configuration = await this.configuration(fixture);
    fixture.run(this.imageArguments);
    const scopeId = 'fixture.runner:' + randomUUID();
    this.scope = await CordisScope.start(this.descriptor(configuration, scopeId), {
      scopeId,
      target: 'deployment',
      principalId: 'fixture',
      resourceScope: 'fixture',
    });
    this.lease = await this.scope.acquire(KataSandboxToken);
    await this.lease.value.ready();
    return this.lease.value;
  }
  private descriptor(configuration: unknown, scopeId: string): CompositionDescriptor {
    return {
      registrations: [
        {
          token: KataSandboxToken,
          declaration: KataSandboxPlugin.declaration,
          plugin: KataSandboxPlugin,
          configuration,
          artifact: { kind: 'bundled', identity: '@treeseed-cordis/deployment' },
        },
      ],
      selections: [
        {
          scopeId,
          capability: KataSandboxToken.id,
          providerId: KataSandboxPlugin.declaration.id,
        },
      ],
    };
  }
  private async exercise(fixture: PrivateKataFixture): Promise<void> {
    const backend = await this.prepare(fixture);
    const id = 'sandbox-' + randomUUID();
    const signal = new AbortController().signal;
    const failures: unknown[] = [];
    try {
      await this.warm(backend, id, signal, fixture);
    } catch (error) {
      failures.push(new Error('fixture-native-root-readiness', { cause: error }));
      failures.push(this.transferEvidence(fixture, id));
    }
    try {
      await backend.destroy(id, signal);
    } catch (error) {
      failures.push(new Error('fixture-physical-destruction', { cause: error }));
    }
    if (failures.length) throw new AggregateError(failures, 'fixture-runner-lifecycle');
    assert.equal(fixture.run(['tasks', 'list', '--quiet']), '');
    assert.equal(fixture.run(['containers', 'list', '--quiet']), '');
  }
  private transferArguments(fixture: PrivateKataFixture, id: string): string[] {
    const name = fixture.namespace + '-' + CanonicalJson.digest({ id }).slice(0, 24);
    const command =
      'if test -f /run/treeseed-runner/guest; then stat -c "payload=%s" /run/treeseed-runner/guest; else printf "payload=missing\\n"; fi; stat -f -c "filesystem=%T,block=%S,available=%a" /run/treeseed-runner';
    return [
      '--address',
      fixture.socket,
      '--namespace',
      fixture.namespace,
      'tasks',
      'exec',
      '--exec-id',
      'failure-readback-' + randomUUID(),
      name,
      '/bin/sh',
      '-c',
      command,
    ];
  }
  private transferEvidence(fixture: PrivateKataFixture, id: string): Error {
    const result = spawnSync('/usr/bin/ctr', this.transferArguments(fixture, id), {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1024,
    });
    const accepted =
      /^payload=(?:missing|[0-9]+)\nfilesystem=[a-zA-Z0-9_-]+,block=[0-9]+,available=[0-9]+\n$/.test(
        result.stdout ?? '',
      );
    return new Error(
      JSON.stringify({
        phase: 'fixture-transfer-readback',
        status: result.status,
        signal: result.signal,
        evidence: accepted ? result.stdout.trim() : 'unavailable',
      }),
    );
  }
  private async warm(
    backend: KataSandboxHost,
    id: string,
    signal: AbortSignal,
    fixture: PrivateKataFixture,
  ): Promise<void> {
    const first = await backend.create(id, signal);
    const ready = this.readiness(first);
    assert.equal(first.assignment, null);
    const second = await backend.inspect(id, signal);
    assert.deepEqual(this.readiness(second).generation, ready.generation);
    this.virgin(fixture, first.resourceName);
    this.privileges(fixture, first.resourceName);
  }
  private readiness(evidence: unknown): CapacityReadiness {
    const result = CapacitySchemas.readiness.parse(Reflect.get(evidence as object, 'runner'));
    assert.equal(result.ready, true);
    assert.equal(result.role, 'runner');
    assert.deepEqual(result.blockers, []);
    assert.match(result.generation.processGeneration, /^[a-f0-9]{64}$/);
    return result;
  }
  private privileges(fixture: PrivateKataFixture, name: string): void {
    assert.equal(
      fixture.run([
        'tasks',
        'exec',
        '--exec-id',
        'privileges-' + randomUUID(),
        name,
        '/bin/sh',
        '-c',
        this.privilegeCheck,
      ]),
      '',
    );
  }
  private virgin(fixture: PrivateKataFixture, name: string): void {
    const result = fixture.run([
      'tasks',
      'exec',
      '--exec-id',
      'inspect-' + randomUUID(),
      name,
      '/bin/sh',
      '-c',
      'test ! -e /run/treeseed-runner/assignment.json && test ! -d /run/treeseed-runner/credentials && test "$(stat -c %u /run/treeseed-runner/guest.json)" = 65532',
    ]);
    assert.equal(result, '');
  }
}

/** Synthetic bounded transport responses, not Agent or Kata readiness evidence. */
class RunnerTransportFixture {
  private buffered = '';
  private count = 0;
  async run(): Promise<void> {
    for await (const bytes of process.stdin) {
      this.buffered += bytes.toString();
      while (this.buffered.includes('\n')) this.frame();
    }
  }
  private frame(): void {
    const index = this.buffered.indexOf('\n');
    const request = CapacityChannelSchemas.request.parse(JSON.parse(this.buffered.slice(0, index)));
    this.buffered = this.buffered.slice(index + 1);
    const mode = process.argv[3];
    if (this.disturbance(mode)) return;
    const response = this.response(request, mode);
    const bytes = JSON.stringify(response) + '\n';
    process.stdout.write(mode === 'duplicate' ? bytes + bytes : bytes);
  }
  private disturbance(mode: string | undefined): boolean {
    if (mode === 'silent') return true;
    if (mode === 'exit') {
      process.exitCode = 1;
      process.stdin.destroy();
      return true;
    }
    if (mode === 'stderr') {
      process.stderr.write('private-canary');
      return true;
    }
    if (mode === 'malformed') {
      process.stdout.write('{"private-canary":1,"private-canary":2}\n');
      return true;
    }
    return false;
  }
  private response(
    request: ReturnType<typeof CapacityChannelSchemas.request.parse>,
    mode: string | undefined,
  ) {
    const generation = {
      compositionGeneration: '1'.repeat(64),
      processGeneration: mode === 'generation' ? String(++this.count).repeat(64) : '2'.repeat(64),
    };
    const scope =
      mode === 'foreign' ? { ...request.scope, workerId: 'foreign.worker' } : request.scope;
    return {
      schemaVersion: request.schemaVersion,
      requestId: request.requestId,
      scope,
      role: 'runner',
      operation: 'ready',
      generation,
      success: true,
      result: this.readiness(scope, generation),
      problem: null,
    };
  }
  private readiness(scope: unknown, generation: unknown) {
    return CapacitySchemas.readiness.parse({
      schemaVersion: 'treeseed.capacity-readiness/v1',
      role: 'runner',
      scope,
      generation,
      ready: true,
      blockers: [],
    });
  }
}

if (import.meta.main) await new KataRunnerProgram().run();

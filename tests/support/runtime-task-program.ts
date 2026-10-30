import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, realpathSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import * as Sandbox from '@treeseed-cordis/deployment/sandbox';
import { RuntimePolicyFixture } from './runtime-policy-program.js';
import { PrivateKataFixture } from './kata-backend-program.js';
import {
  CordisScope,
  type ProviderLease,
  type ProviderRegistration,
  type CompositionDescriptor,
} from '@treeseed-cordis/sdk/runtime';

export const TASK_CONFIGURATION_INPUT = {
  scope: { installationId: 'fixture', serviceId: 'worker', providerGeneration: 'a'.repeat(64) },
  custody: '/PRIVATE_CUSTODY',
  endpointDirectory: '/PRIVATE_ENDPOINT',
  daemon: { pid: 1, startTime: '1', commandDigest: 'b'.repeat(64) },
  client: { path: '/PRIVATE_CLIENT', sha256: 'c'.repeat(64) },
  runtime: {
    version: '4.1.0',
    guestKernel: '6.18.35',
    shim: { path: '/PRIVATE_SHIM', sha256: 'd'.repeat(64) },
    hypervisor: { path: '/PRIVATE_QEMU', sha256: 'e'.repeat(64) },
    configuration: { path: '/PRIVATE_CONFIGURATION', sha256: 'f'.repeat(64) },
  },
  image: 'fixture/native@sha256:' + '1'.repeat(64),
};

/** Hosted fixture retains installed members; it never extracts or edits the installed kit. */
export class NativePolicyFixture {
  private archive: Sandbox.RuntimeArchiveCustody | null = null;
  private components: Sandbox.RuntimeComponentCustody | null = null;
  private aliases: Sandbox.RuntimeAliasCustody | null = null;
  policy: Sandbox.EffectiveRuntimePolicy | null = null;
  readonly resources = { vcpus: 2, memoryMiB: 1024, scratchMiB: 64 };
  readonly signal = new AbortController().signal;
  constructor(readonly directory: string) {}
  async prepare(): Promise<string> {
    await this.retain();
    const prepared = await this.effective();
    this.policy = prepared.policy;
    return prepared.path;
  }
  private async retain(): Promise<void> {
    const path = '/opt/kata/kata-static-4.1.0-amd64.tar.zst';
    this.archive = await Sandbox.RuntimeArchiveCustody.open(
      {
        path,
        size: 969565384,
        sha256: '3dc6b69c4acb787b967b04b64599a20d02a8beb1a8eaab3084110df9d0b08c96',
      },
      this.signal,
    );
    const members = [];
    for (const [, member] of RuntimePolicyFixture.selections) members.push(member);
    const inspected = await this.archive.inspect(members, this.signal);
    this.components = await Sandbox.RuntimeComponentCustody.open(
      this.archive,
      this.bindings(inspected),
      this.signal,
    );
    this.aliases = await Sandbox.RuntimeAliasCustody.open(this.components, '/', this.signal);
  }
  private bindings(inspected: Sandbox.RuntimeKitMembers): Sandbox.RuntimeComponentBinding[] {
    const bindings = [];
    for (const [role, requested] of RuntimePolicyFixture.selections) {
      const member = inspected.members.find(NativePolicyFixture.requested.bind(null, requested));
      assert(member);
      bindings.push({ role, member: requested, path: '/' + member.path });
    }
    return bindings;
  }
  private static requested(path: string, member: Sandbox.RuntimeKitMember): boolean {
    return member.requestedPath === path;
  }
  private document(memoryMiB: number): string {
    const template = '/' + RuntimePolicyFixture.selections[0][1];
    const document = parse(readFileSync(template, 'utf8'), { integersAsBigInt: true });
    const qemu = (document.hypervisor as Record<string, unknown>).qemu as Record<string, unknown>;
    Object.assign(qemu, {
      default_vcpus: 3n,
      default_maxvcpus: 3n,
      default_memory: BigInt(memoryMiB + 32),
      default_maxmemory: BigInt(memoryMiB + 32 + 256),
      memory_slots: 1n,
      enable_annotations: [],
    });
    return stringify(document);
  }
  private async effective(
    name = 'launch-policy',
    memoryMiB = 1024,
  ): Promise<{
    path: string;
    policy: Sandbox.EffectiveRuntimePolicy;
  }> {
    const parent = join(this.directory, name);
    mkdirSync(parent, { mode: 0o700 });
    const path = join(parent, 'effective.toml'),
      bytes = Buffer.from(this.document(memoryMiB));
    writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
    const policy = await Sandbox.EffectiveRuntimePolicy.open(
      {
        configuration: {
          path,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
        resources: { ...this.resources, memoryMiB },
      },
      this.components!,
      this.aliases!,
      this.signal,
    );
    return { path, policy };
  }
  async mismatch(): Promise<Sandbox.EffectiveRuntimePolicy> {
    const alternate = await this.effective('mismatch-policy', 1025);
    assert.notEqual(alternate.policy.proof.digest, this.policy!.proof.digest);
    assert.equal(alternate.policy.proof.resources.memoryMiB, 1025);
    return alternate.policy;
  }
  close(): void {
    const failures = [];
    for (const resource of [this.policy, this.aliases, this.components, this.archive])
      try {
        resource?.close();
      } catch (error) {
        failures.push(error);
      }
    if (failures.length)
      throw new AggregateError(failures, 'Installed policy fixture disposal failed');
  }
}
/** Real default backend and pinned upstream data, never a replacement sandbox provider. */
class NativeTaskScenario {
  private readonly fixture = new PrivateKataFixture();
  private readonly custody = new NativePolicyFixture(this.fixture.directory);
  private readonly id = 'sandbox-' + randomUUID();
  private readonly previous = process.env.KATA_CONF_FILE;
  private backend: Sandbox.KataSandboxHost | null = null;
  private scope: CordisScope | null = null;
  private lease: ProviderLease<Sandbox.KataSandboxHost> | null = null;
  private active = false;
  async run(): Promise<void> {
    const failures = [];
    try {
      await this.exercise();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.dispose();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, 'Native task selection failed');
  }
  private async exercise(): Promise<void> {
    process.env.KATA_CONF_FILE = await this.custody.prepare();
    await this.masked();
    const created = await this.create();
    this.observed(created);
    this.selection(created);
    assert.deepEqual(
      (await this.backend!.inspect(this.id, this.custody.signal)).boot,
      created.boot,
    );
    await this.destroy();
    await assert.rejects(this.backend!.inspect.bind(this.backend, this.id, this.custody.signal), {
      message: 'KATA_SANDBOX_DESTROYED',
    });
    this.custody.policy!.verify();
  }
  private async create(): Promise<Sandbox.KataSandboxEvidence> {
    await this.fixture.start('task-options');
    const configuration = (await this.fixture.configuration()) as Record<string, unknown>;
    this.fixture.run([
      'images',
      'pull',
      '--platform',
      'linux/amd64',
      configuration.image as string,
    ]);
    this.backend = await this.native({
      ...configuration,
      resources: this.custody.resources,
    });
    this.active = true;
    return this.backend.create(this.id, this.custody.signal);
  }
  private async native(configuration: unknown): Promise<Sandbox.KataSandboxHost> {
    const scopeId = 'installation:' + this.fixture.namespaceScope.installationId + ':host';
    this.scope = await CordisScope.start(this.composition(scopeId, configuration), {
      scopeId,
      target: 'deployment',
      principalId: 'uid:0',
      resourceScope: this.fixture.namespaceScope.installationId,
    });
    this.lease = await this.scope.acquire(Sandbox.KataSandboxToken);
    await this.lease.value.ready();
    return this.lease.value;
  }
  private composition(scopeId: string, configuration: unknown): CompositionDescriptor {
    return {
      registrations: [this.registration(configuration)],
      selections: [
        {
          scopeId,
          capability: Sandbox.KataSandboxToken.id,
          providerId: Sandbox.KataSandboxPlugin.declaration.id,
        },
      ],
    };
  }
  private registration(configuration: unknown): ProviderRegistration {
    const metadata = JSON.parse(
      readFileSync(
        new URL('../../package.json', import.meta.resolve('@treeseed-cordis/deployment/sandbox')),
        'utf8',
      ),
    );
    return {
      token: Sandbox.KataSandboxToken,
      plugin: Sandbox.KataSandboxPlugin,
      declaration: Sandbox.KataSandboxPlugin.declaration,
      configuration,
      artifact: { kind: 'bundled', identity: metadata.name + '@' + metadata.version },
    };
  }
  private async masked(): Promise<void> {
    const fixture = new PrivateKataFixture(),
      failures = [];
    try {
      await this.maskedOperation(fixture);
    } catch (error) {
      failures.push(error);
    }
    try {
      await fixture.stop();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, 'Masked task selection failed');
  }
  private async maskedOperation(fixture: PrivateKataFixture): Promise<void> {
    await fixture.start();
    const input = (await fixture.configuration()) as Record<string, unknown>;
    const runtime = { ...(input.runtime as object), configurationMode: 'task-options' };
    const before = readdirSync(fixture.directory).sort();
    await assert.rejects(this.refused.bind(this, { ...input, runtime }), {
      message: 'KATA_RUNTIME_CONFIGURATION',
    });
    assert.deepEqual(readdirSync(fixture.directory).sort(), before);
    assert.equal(fixture.run(['containers', 'list', '--quiet']), '');
    assert.equal(fixture.run(['tasks', 'list', '--quiet']), '');
  }
  private async refused(input: unknown): Promise<void> {
    const backend = await Sandbox.KataSandboxBackend.open(input);
    try {
      assert.fail('Masked configuration unexpectedly admitted');
    } finally {
      await backend.close();
    }
  }
  private observed(created: Sandbox.KataSandboxEvidence): void {
    assert.deepEqual(created.boot.boot.resources, {
      vcpus: 3,
      maximumVcpus: 3,
      memoryMiB: 1056,
      maximumMemoryMiB: 1312,
    });
    assert.equal(created.boot.boot.rootfs.size, 268435456);
    assert.equal(realpathSync(created.boot.boot.kernel), '/' + this.member('kernel').path);
    assert.equal(created.boot.process.executableDigest, this.member('hypervisor').sha256);
    assert.equal(created.assignment, null);
    assert.equal(created.runner, null);
  }
  private member(role: string): Sandbox.RuntimeKitMember {
    for (const component of this.custody.policy!.proof.components)
      if (component.role === role) return component.member;
    throw new Error('Native fixture member missing');
  }
  private selection(created: Sandbox.KataSandboxEvidence): void {
    const info = JSON.parse(this.fixture.run(['containers', 'info', created.resourceName]));
    const path = process.env.KATA_CONF_FILE!,
      bytes = Buffer.from(path);
    assert(bytes.length < 128);
    assert.deepEqual(info.Runtime.Options, {
      type_url: 'runtimeoptions.v1.Options',
      value: Buffer.concat([Buffer.from([0x12, bytes.length]), bytes]).toString('base64'),
    });
  }
  private async destroy(): Promise<void> {
    if (!this.backend || !this.active) return;
    assert.equal((await this.backend.destroy(this.id, this.custody.signal)).destroyed, true);
    this.active = false;
  }
  private async disposeNative(): Promise<void> {
    const failures = [];
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
  private restore(): void {
    if (this.previous === undefined) delete process.env.KATA_CONF_FILE;
    else process.env.KATA_CONF_FILE = this.previous;
  }
  private async dispose(): Promise<void> {
    const failures = [];
    for (const release of [
      this.destroy.bind(this),
      this.disposeNative.bind(this),
      this.fixture.stop.bind(this.fixture),
      this.custody.close.bind(this.custody),
      this.restore.bind(this),
    ])
      try {
        await release();
      } catch (error) {
        failures.push(error);
      }
    if (failures.length) throw new AggregateError(failures, 'Native task cleanup failed');
  }
}
class RuntimeTaskProgram {
  static async run(): Promise<void> {
    if (process.argv[2] === '--interface') await this.interface();
    else {
      await new NativeTaskScenario().run();
      process.stdout.write('kata-task-configuration-public-ok\n');
    }
  }
  private static async interface(): Promise<void> {
    const configuration = Sandbox.KataSandboxPlugin.Config.parse(TASK_CONFIGURATION_INPUT);
    assert.equal(Reflect.get(configuration.runtime, 'configurationMode'), 'environment');
    const runtime = { ...TASK_CONFIGURATION_INPUT.runtime, configurationMode: 'task-options' };
    const selected = Sandbox.KataSandboxPlugin.Config.parse({
      ...TASK_CONFIGURATION_INPUT,
      runtime,
    });
    assert.equal(Reflect.get(selected.runtime, 'configurationMode'), 'task-options');
    const invalid = { ...runtime, configurationMode: 'PRIVATE_INVALID_MODE' };
    await assert.rejects(
      Sandbox.KataSandboxBackend.open.bind(Sandbox.KataSandboxBackend, {
        ...TASK_CONFIGURATION_INPUT,
        runtime: invalid,
      }),
      { message: 'KATA_CONFIGURATION_INVALID' },
    );
    process.stdout.write('kata-task-configuration-interface-ok\n');
  }
}
if (import.meta.main) await RuntimeTaskProgram.run();

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import * as Sandbox from '@treeseed-cordis/deployment/sandbox';
import { TASK_CONFIGURATION_INPUT, NativePolicyFixture } from './runtime-task-program.js';
import { PrivateKataFixture } from './kata-backend-program.js';
import {
  CordisScope,
  type ProviderLease,
  type CompositionDescriptor,
} from '@treeseed-cordis/sdk/runtime';

export class NativePolicyInput {
  static readonly components = [
    'configuration',
    'hypervisor',
    'kernel',
    'rootfs',
    'shim',
    'virtiofs',
  ].map(NativePolicyInput.component);
  private static readonly input = {
    ...TASK_CONFIGURATION_INPUT,
    resources: { vcpus: 2, memoryMiB: 1024, scratchMiB: 64 },
    runtime: {
      ...TASK_CONFIGURATION_INPUT.runtime,
      configurationMode: 'task-options',
      archive: { path: '/PRIVATE_ARCHIVE', size: 4, sha256: 'a'.repeat(64) },
      shim: { ...TASK_CONFIGURATION_INPUT.runtime.shim, path: '/opt/kata/shim' },
      hypervisor: { ...TASK_CONFIGURATION_INPUT.runtime.hypervisor, path: '/opt/kata/hypervisor' },
      policy: { components: NativePolicyInput.components },
    },
  };
  static component(role: string): { role: string; member: string; path: string } {
    return { role, member: 'opt/kata/' + role, path: '/opt/kata/' + role };
  }
  static selected() {
    return structuredClone(this.input);
  }
}
class NativePolicyScenario {
  private readonly fixture = new PrivateKataFixture();
  private readonly custody = new NativePolicyFixture(this.fixture.directory);
  private readonly id = 'sandbox-' + randomUUID();
  private readonly previous = process.env.KATA_CONF_FILE;
  private scope: CordisScope | null = null;
  private lease: ProviderLease<Sandbox.KataSandboxHost> | null = null;
  private path = '';
  private bytes: Buffer | null = null;
  private tampered = false;
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
    if (failures.length) throw new AggregateError(failures, 'Native policy lifecycle failed');
  }
  private async exercise(): Promise<void> {
    const configuration = await this.prepare();
    await this.native(configuration);
    this.active = true;
    const created = await this.lease!.value.create(this.id, this.custody.signal);
    this.observed(created);
    this.custody.close();
    assert.throws(this.custody.policy!.verify.bind(this.custody.policy), {
      message: 'KATA_RUNTIME_POLICY_CLOSED',
    });
    const inspected = await this.lease!.value.inspect(this.id, this.custody.signal);
    assert.deepEqual(inspected.boot, created.boot);
    await this.destroy();
    await this.changed();
  }
  private async prepare(): Promise<object> {
    this.path = await this.custody.prepare();
    process.env.KATA_CONF_FILE = this.path;
    this.bytes = readFileSync(this.path);
    await this.fixture.start('task-options');
    const configuration = (await this.fixture.configuration()) as Record<string, unknown>;
    this.fixture.run([
      'images',
      'pull',
      '--platform',
      'linux/amd64',
      configuration.image as string,
    ]);
    return {
      ...configuration,
      resources: this.custody.resources,
      runtime: {
        ...(configuration.runtime as object),
        policy: { components: this.custody.policy!.proof.bindings },
      },
    };
  }
  private async native(configuration: object): Promise<void> {
    const scopeId = 'installation:' + this.fixture.namespaceScope.installationId + ':host';
    this.scope = await CordisScope.start(this.composition(scopeId, configuration), {
      scopeId,
      target: 'deployment',
      principalId: 'uid:0',
      resourceScope: this.fixture.namespaceScope.installationId,
    });
    this.lease = await this.scope.acquire(Sandbox.KataSandboxToken);
    await this.lease.value.ready();
  }
  private composition(scopeId: string, configuration: object): CompositionDescriptor {
    return {
      registrations: [
        {
          token: Sandbox.KataSandboxToken,
          plugin: Sandbox.KataSandboxPlugin,
          declaration: Sandbox.KataSandboxPlugin.declaration,
          configuration,
          artifact: { kind: 'bundled', identity: this.identity() },
        },
      ],
      selections: [
        {
          scopeId,
          capability: Sandbox.KataSandboxToken.id,
          providerId: Sandbox.KataSandboxPlugin.declaration.id,
        },
      ],
    };
  }
  private identity(): string {
    const metadata = JSON.parse(
      readFileSync(
        new URL('../../package.json', import.meta.resolve('@treeseed-cordis/deployment/sandbox')),
        'utf8',
      ),
    );
    return metadata.name + '@' + metadata.version;
  }
  private observed(created: Sandbox.KataSandboxEvidence): void {
    assert.deepEqual(created.boot.boot.resources, {
      vcpus: 3,
      maximumVcpus: 3,
      memoryMiB: 1056,
      maximumMemoryMiB: 1312,
    });
    assert.equal(created.assignment, null);
    assert.equal(created.runner, null);
  }
  private async changed(): Promise<void> {
    this.tampered = true;
    writeFileSync(this.path, Buffer.concat([this.bytes!, Buffer.from('\n# changed\n')]));
    await assert.rejects(this.lease!.value.ready.bind(this.lease!.value), {
      message: 'KATA_RUNTIME_POLICY_CHANGED',
    });
  }
  private async destroy(): Promise<void> {
    if (!this.active || !this.lease) return;
    assert.equal((await this.lease.value.destroy(this.id, this.custody.signal)).destroyed, true);
    this.active = false;
  }
  private restore(): void {
    if (this.tampered && this.bytes) writeFileSync(this.path, this.bytes);
    if (this.previous === undefined) delete process.env.KATA_CONF_FILE;
    else process.env.KATA_CONF_FILE = this.previous;
  }
  private async nativeDispose(): Promise<void> {
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
    if (failures.length) throw new AggregateError(failures, 'Native policy root disposal failed');
  }
  private async dispose(): Promise<void> {
    const failures = [];
    for (const release of [
      this.restore.bind(this),
      this.destroy.bind(this),
      this.nativeDispose.bind(this),
      this.fixture.stop.bind(this.fixture),
      this.custody.close.bind(this.custody),
    ])
      try {
        await release();
      } catch (error) {
        failures.push(error);
      }
    if (failures.length) throw new AggregateError(failures, 'Native policy cleanup failed');
  }
}
class NativePolicyProgram {
  static async main(): Promise<void> {
    if (process.argv[2] === '--hosted') {
      await new NativePolicyScenario().run();
      process.stdout.write('native-policy-lifecycle-ok\n');
    } else await this.run();
  }
  static async run(): Promise<void> {
    const selected = NativePolicyInput.selected();
    const parsed = Sandbox.KataSandboxPlugin.Config.parse(selected);
    assert.deepEqual(Reflect.get(parsed.runtime, 'policy'), {
      components: NativePolicyInput.components,
    });
    await this.incomplete(selected);
    process.stdout.write('native-policy-interface-ok\n');
  }
  private static async incomplete(input: object): Promise<void> {
    const selected = input as { runtime: Record<string, unknown> };
    const runtime = { ...selected.runtime, archive: undefined };
    await assert.rejects(
      Sandbox.KataSandboxBackend.open.bind(Sandbox.KataSandboxBackend, { ...input, runtime }),
      { message: 'KATA_CONFIGURATION_INVALID' },
    );
  }
}
if (import.meta.main) await NativePolicyProgram.main();

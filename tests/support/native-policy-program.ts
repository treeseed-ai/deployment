import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, readlinkSync } from 'node:fs';
import * as Sandbox from '@treeseed-cordis/deployment/sandbox';
import { CanonicalJson } from '@treeseed-cordis/sdk';
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
class NativeNetworkAssertions {
  static observed(record: Sandbox.KataSandboxEvidence): void {
    const network = Reflect.get(record, 'network');
    const content = {
      kind: 'kata-offline-network',
      formatVersion: 1,
      mode: 'offline',
      namespace: 'private',
      bootDigest: record.boot.digest,
    };
    assert.deepEqual(network, { ...content, digest: CanonicalJson.digest(content) });
    assert(Object.isFrozen(network));
  }
  static interface(): void {
    const Type = Reflect.get(Sandbox, 'NativeNetworkProjection');
    assert.equal(typeof Type, 'function', 'Public native network projection missing');
    const projection = new Type();
    const spec = { linux: { namespaces: [{ type: 'network' }] } };
    const evidence = projection.read(spec, 'a'.repeat(64), '/sys/class/net/lo\n');
    assert.equal(evidence.bootDigest, 'a'.repeat(64));
    assert.equal(evidence.mode, 'offline');
    assert(Object.isFrozen(evidence));
    spec.linux.namespaces.push({ type: 'network' });
    assert.throws(projection.read.bind(projection, spec, 'a'.repeat(64), '/sys/class/net/lo\n'), {
      message: 'KATA_NATIVE_NETWORK_INVALID',
    });
  }
}
interface RuntimeBinding {
  kind: string;
  formatVersion: number;
  policyDigest: string;
  bootDigest: string;
  sandboxName: string;
  namespace: string;
  shim: Sandbox.KataSandboxEvidence['hypervisor'];
  digest: string;
}
interface RuntimeAdmission {
  readonly proof: Sandbox.KataLaunchProof;
  readonly binding: RuntimeBinding;
  verify(): void;
  close(): void;
}
interface RuntimePolicyOwner {
  runtimeLaunch(name: string, signal: AbortSignal): Promise<RuntimeAdmission>;
  filesystemLaunch(name: string, signal: AbortSignal): Promise<FilesystemAdmission>;
  verify(): void;
  close(): void;
}
interface FilesystemBinding {
  kind: string;
  formatVersion: number;
  policyDigest: string;
  runtimeDigest: string;
  bootDigest: string;
  daemon: RuntimeBinding['shim'];
  server: RuntimeBinding['shim'];
  socket: Readonly<{ inode: string; pathDigest: string; state: string }>;
  shared: Readonly<{ device: number; inode: number }>;
  digest: string;
}
interface FilesystemAdmission {
  readonly proof: Sandbox.KataLaunchProof;
  readonly runtime: RuntimeBinding;
  readonly binding: FilesystemBinding;
  verify(): void;
  close(): void;
}
class NativeFilesystemAssertions {
  static interface(): void {
    const Type = Reflect.get(Sandbox, 'NativeFilesystemProjection');
    assert.equal(typeof Type, 'function', 'Public native filesystem projection missing');
    const Admission = Reflect.get(Sandbox, 'NativeFilesystemAttestation');
    assert.equal(typeof Admission?.open, 'function', 'Public native filesystem admission missing');
  }
  static observed(
    record: Sandbox.KataSandboxEvidence,
    policy: Sandbox.EffectiveRuntimePolicyProof,
  ): void {
    const binding = Reflect.get(record, 'filesystem') as FilesystemBinding;
    const runtime = Reflect.get(record, 'runtime') as RuntimeBinding;
    assert(binding, 'Native filesystem binding missing');
    assert.equal(binding.kind, 'kata-filesystem-binding');
    assert.equal(binding.formatVersion, 1);
    assert.equal(binding.bootDigest, record.boot.digest);
    assert.equal(binding.runtimeDigest, runtime.digest);
    assert.equal(binding.policyDigest, runtime.policyDigest);
    const selected = policy.components.find(NativeFilesystemAssertions.virtiofs);
    assert(selected);
    this.process(binding.daemon, selected.member.sha256);
    this.process(binding.server, selected.member.sha256);
    assert.notEqual(binding.daemon.pid, binding.server.pid);
    this.immutable(binding);
  }
  private static virtiofs(value: { role: string }): boolean {
    return value.role === 'virtiofs';
  }
  private static process(value: RuntimeBinding['shim'], digest: string): void {
    assert(Number.isSafeInteger(value.pid) && value.pid > 1);
    assert.match(value.startTime, /^[0-9]+$/);
    assert.match(value.commandDigest, /^[a-f0-9]{64}$/);
    assert.equal(value.executableDigest, digest);
    assert(Object.isFrozen(value));
  }
  private static immutable(binding: FilesystemBinding): void {
    assert.equal(binding.socket.state, 'connected');
    assert.match(binding.socket.inode, /^[1-9][0-9]*$/);
    assert.match(binding.socket.pathDigest, /^[a-f0-9]{64}$/);
    assert(Number.isSafeInteger(binding.shared.device));
    assert(Number.isSafeInteger(binding.shared.inode) && binding.shared.inode > 0);
    for (const value of [binding, binding.socket, binding.shared]) assert(Object.isFrozen(value));
    const { digest, ...content } = binding;
    assert.equal(digest, CanonicalJson.digest(content));
    assert(!JSON.stringify(binding).includes('/run/'));
  }
  static same(actual: FilesystemBinding, expected: FilesystemBinding): void {
    assert.equal(actual.bootDigest, expected.bootDigest);
    assert.deepEqual(actual.daemon, expected.daemon);
    assert.deepEqual(actual.server, expected.server);
    assert.deepEqual(actual.socket, expected.socket);
    assert.deepEqual(actual.shared, expected.shared);
  }
}
class NativeShimAssertions {
  static interface(): void {
    const Type = Reflect.get(Sandbox, 'NativeShimProjection');
    assert.equal(typeof Type, 'function', 'Public native shim projection missing');
    assert.equal(typeof Reflect.get(Sandbox, 'NativeRuntimeAttestation')?.open, 'function');
    const name = 'cordis-sandbox-' + 'a'.repeat(24) + '-' + 'b'.repeat(24);
    const namespace = name.slice(0, -25);
    const args = ['shim', '-id', name, '-namespace', namespace];
    assert.deepEqual(new Type().parse(args, name), { sandboxName: name, namespace });
  }
  static observed(
    record: Sandbox.KataSandboxEvidence,
    policy: Sandbox.EffectiveRuntimePolicyProof,
  ): void {
    const binding = Reflect.get(record, 'runtime') as RuntimeBinding;
    assert(binding && typeof binding === 'object', 'Native runtime binding missing');
    assert.equal(binding.kind, 'kata-runtime-binding');
    assert.equal(binding.formatVersion, 1);
    assert.match(binding.policyDigest, /^[a-f0-9]{64}$/);
    assert.equal(binding.bootDigest, record.boot.digest);
    assert.equal(binding.sandboxName, record.resourceName);
    assert.equal(binding.namespace, record.resourceName.slice(0, -25));
    const selected = policy.components.find(NativeShimAssertions.shim);
    assert(selected);
    this.process(binding.shim, selected.member.sha256);
    this.immutable(binding);
  }
  private static shim(value: { role: string }): boolean {
    return value.role === 'shim';
  }
  private static process(value: RuntimeBinding['shim'], digest: string): void {
    assert(Number.isSafeInteger(value.pid) && value.pid > 1);
    assert.match(value.startTime, /^[0-9]+$/);
    assert.match(value.commandDigest, /^[a-f0-9]{64}$/);
    assert.equal(value.executableDigest, digest);
    assert(Object.isFrozen(value));
  }
  private static immutable(binding: RuntimeBinding): void {
    const { digest, ...content } = binding;
    assert.equal(digest, CanonicalJson.digest(content));
    assert(Object.isFrozen(binding));
  }
}
class NativeRuntimeFixture {
  private archive: Sandbox.RuntimeArchiveCustody | null = null;
  private owner: RuntimePolicyOwner | null = null;
  private admission: RuntimeAdmission | null = null;
  private filesystem: FilesystemAdmission | null = null;
  private readonly signal = new AbortController().signal;
  async prepare(input: object): Promise<void> {
    const configuration = Sandbox.KataSandboxPlugin.Config.parse(input);
    assert(configuration.runtime.archive);
    this.archive = await Sandbox.RuntimeArchiveCustody.open(
      configuration.runtime.archive,
      this.signal,
    );
    this.owner = (await Sandbox.NativePolicyCustody.open(
      configuration,
      this.archive,
      this.signal,
    )) as unknown as RuntimePolicyOwner;
    assert(this.owner && typeof this.owner.runtimeLaunch === 'function');
    assert.equal(typeof this.owner.filesystemLaunch, 'function');
  }
  async admitted(record: Sandbox.KataSandboxEvidence): Promise<void> {
    this.admission = await this.owner!.runtimeLaunch(record.resourceName, this.signal);
    this.admission.verify();
    const binding = Reflect.get(record, 'runtime') as RuntimeBinding;
    assert.equal(this.admission.binding.bootDigest, record.boot.digest);
    assert.deepEqual(this.admission.binding.shim, binding.shim);
    await this.refused(record.resourceName);
    await this.repeated(record.resourceName);
    await this.filesystemAdmitted(record);
  }
  private async filesystemAdmitted(record: Sandbox.KataSandboxEvidence): Promise<void> {
    this.filesystem = await this.owner!.filesystemLaunch(record.resourceName, this.signal);
    this.filesystem.verify();
    NativeFilesystemAssertions.same(this.filesystem.binding, Reflect.get(record, 'filesystem'));
    assert.deepEqual(this.filesystem.runtime, this.admission!.binding);
    await this.filesystemRefused(record.resourceName);
    await this.filesystemRepeated(record.resourceName);
  }
  private async filesystemRefused(name: string): Promise<void> {
    await assert.rejects(this.owner!.filesystemLaunch.bind(this.owner, name, AbortSignal.abort()), {
      message: 'KATA_CANCELLED',
    });
    const suffix = name.endsWith('0'.repeat(24)) ? '1' : '0';
    const other = name.slice(0, -24) + suffix.repeat(24);
    await assert.rejects(this.owner!.filesystemLaunch.bind(this.owner, other, this.signal), {
      message: 'KATA_FILESYSTEM_INVALID',
    });
    this.filesystem!.verify();
  }
  private async filesystemRepeated(name: string): Promise<void> {
    const repeated = await this.owner!.filesystemLaunch(name, this.signal);
    try {
      repeated.verify();
      assert.deepEqual(repeated.binding, this.filesystem!.binding);
    } finally {
      repeated.close();
    }
    assert.throws(repeated.verify.bind(repeated), { message: 'KATA_FILESYSTEM_CLOSED' });
    this.owner!.verify();
    this.filesystem!.verify();
    this.admission!.verify();
  }
  private async refused(name: string): Promise<void> {
    await assert.rejects(this.owner!.runtimeLaunch.bind(this.owner, name, AbortSignal.abort()), {
      message: 'KATA_CANCELLED',
    });
    const suffix = name.endsWith('0'.repeat(24)) ? '1' : '0';
    const other = name.slice(0, -24) + suffix.repeat(24);
    await assert.rejects(this.owner!.runtimeLaunch.bind(this.owner, other, this.signal), {
      message: 'KATA_RUNTIME_INVALID',
    });
    this.admission!.verify();
  }
  private async repeated(name: string): Promise<void> {
    const repeated = await this.owner!.runtimeLaunch(name, this.signal);
    try {
      repeated.verify();
      assert.deepEqual(repeated.binding, this.admission!.binding);
    } finally {
      repeated.close();
    }
    assert.throws(repeated.verify.bind(repeated), { message: 'KATA_RUNTIME_CLOSED' });
    this.owner!.verify();
    this.admission!.verify();
  }
  observed(): void {
    this.admission!.verify();
    this.filesystem!.verify();
  }
  destroyed(): void {
    assert.throws(this.admission!.verify.bind(this.admission), { message: 'KATA_RUNTIME_CHANGED' });
    assert.throws(this.filesystem!.verify.bind(this.filesystem), {
      message: 'KATA_FILESYSTEM_CHANGED',
    });
    this.filesystem!.close();
    assert.throws(this.filesystem!.verify.bind(this.filesystem), {
      message: 'KATA_FILESYSTEM_CLOSED',
    });
    this.admission!.close();
    assert.throws(this.admission!.verify.bind(this.admission), { message: 'KATA_RUNTIME_CLOSED' });
    this.close();
  }
  close(): void {
    const failures = [];
    for (const owned of [this.filesystem, this.admission, this.owner, this.archive])
      try {
        owned?.close();
      } catch (error) {
        failures.push(error);
      }
    if (failures.length)
      throw new AggregateError(failures, 'Native runtime fixture disposal failed');
  }
}
class NativePolicyScenario {
  private readonly fixture = new PrivateKataFixture();
  private readonly custody = new NativePolicyFixture(this.fixture.directory);
  private readonly runtime = new NativeRuntimeFixture();
  private readonly id = 'sandbox-' + randomUUID();
  private readonly previous = process.env.KATA_CONF_FILE;
  private scope: CordisScope | null = null;
  private lease: ProviderLease<Sandbox.KataSandboxHost> | null = null;
  private path = '';
  private bytes: Buffer | null = null;
  private tampered = false;
  private before: string[] | null = null;
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
    await this.runtime.prepare(configuration);
    this.active = true;
    const created = await this.lease!.value.create(this.id, this.custody.signal);
    this.observed(created);
    await this.runtime.admitted(created);
    this.custody.close();
    assert.throws(this.custody.policy!.verify.bind(this.custody.policy), {
      message: 'KATA_RUNTIME_POLICY_CLOSED',
    });
    const inspected = await this.lease!.value.inspect(this.id, this.custody.signal);
    this.observed(inspected);
    this.runtime.observed();
    assert.deepEqual(inspected.boot, created.boot);
    await this.destroy();
    this.runtime.destroyed();
    await this.changed();
  }
  private async prepare(): Promise<object> {
    await this.fixture.start('task-options');
    this.before = this.descriptors();
    this.path = await this.custody.prepare();
    process.env.KATA_CONF_FILE = this.path;
    this.bytes = readFileSync(this.path);
    const configuration = await this.prepareImage();
    return {
      ...configuration,
      resources: this.custody.resources,
      runtime: {
        ...(configuration.runtime as object),
        policy: { components: this.custody.policy!.proof.bindings },
      },
    };
  }
  private async prepareImage(): Promise<Record<string, unknown>> {
    const configuration = (await this.fixture.configuration()) as Record<string, unknown>;
    this.fixture.run([
      'images',
      'pull',
      '--platform',
      'linux/amd64',
      configuration.image as string,
    ]);
    return configuration;
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
    NativeNetworkAssertions.observed(created);
    NativeShimAssertions.observed(created, this.custody.policy!.proof);
    NativeFilesystemAssertions.observed(created, this.custody.policy!.proof);
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
    writeFileSync(this.path, this.bytes!);
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
  private descriptors(): string[] {
    const paths = [];
    for (const fd of readdirSync('/proc/self/fd'))
      try {
        const path = readlinkSync('/proc/self/fd/' + fd);
        if (
          path === '/' ||
          path === '/opt/kata' ||
          path.startsWith('/opt/kata/') ||
          path === this.fixture.directory ||
          path.startsWith(this.fixture.directory + '/')
        )
          paths.push(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    return paths.sort();
  }
  private released(): void {
    if (this.before) assert.deepEqual(this.descriptors(), this.before);
  }
  private async dispose(): Promise<void> {
    const failures = [];
    for (const release of [
      this.restore.bind(this),
      this.destroy.bind(this),
      this.runtime.close.bind(this.runtime),
      this.custody.close.bind(this.custody),
      this.nativeDispose.bind(this),
      this.released.bind(this),
      this.fixture.stop.bind(this.fixture),
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
    NativeFilesystemAssertions.interface();
    NativeShimAssertions.interface();
    NativeNetworkAssertions.interface();
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

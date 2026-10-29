import assert from 'node:assert/strict';
import { test, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import {
  appendFileSync,
  chmodSync,
  rmSync,
  symlinkSync,
  readdirSync,
  readlinkSync,
  closeSync,
  openSync,
  fstatSync,
} from 'node:fs';
import { parse, stringify } from 'smol-toml';
import { RuntimePolicyFixture, type EffectivePolicy } from '../support/runtime-policy-program.js';
type Table = Record<string, unknown>;
class EffectivePolicyMutations {
  static text(text: string, mode: string): string {
    const document = parse(text, { integersAsBigInt: true }) as Table;
    this.resources(document, mode);
    this.security(document, mode);
    this.structure(document, mode);
    const result = stringify(document);
    if (mode === 'float') return result.replace('default_vcpus = 3\n', 'default_vcpus = 3.0\n');
    if (mode === 'duplicate') return result + '\n[hypervisor.qemu]\npath = "PRIVATE_DUPLICATE"\n';
    return result;
  }
  private static qemu(document: Table): Table {
    return (document.hypervisor as Table).qemu as Table;
  }
  private static resources(document: Table, mode: string): void {
    const qemu = this.qemu(document);
    if (mode === 'zero-cpu-max') qemu.default_maxvcpus = 0n;
    if (mode === 'excess-cpu-max') qemu.default_maxvcpus = 4n;
    if (mode === 'missing-overhead') qemu.default_memory = 1024n;
    if (mode === 'zero-memory-max') qemu.default_maxmemory = 0n;
    if (mode === 'excess-memory-max') qemu.default_maxmemory = 2048n;
    if (mode === 'slots') qemu.memory_slots = 2n;
    if (mode === 'dynamic-resources')
      (document.runtime as Table).static_sandbox_resource_mgmt = false;
    if (mode === 'nonfinite') qemu.overhead_vcpus = Number.NaN;
  }
  private static security(document: Table, mode: string): void {
    const qemu = this.qemu(document),
      runtime = document.runtime as Table;
    if (mode === 'annotations') qemu.enable_annotations = ['kernel_params'];
    if (mode === 'hook') qemu.guest_hook_path = '/PRIVATE_HOOK_CANARY';
    if (mode === 'kernel') qemu.kernel = '/PRIVATE_KERNEL_CANARY';
    if (mode === 'network') runtime.internetworking_model = 'none';
    if (mode === 'debug') ((document.agent as Table).kata as Table).debug_console_enabled = true;
    if (mode === 'security') runtime.disable_guest_seccomp = false;
    if (mode === 'command') qemu.command = 'PRIVATE_COMMAND_CANARY';
  }
  private static structure(document: Table, mode: string): void {
    const qemu = this.qemu(document);
    if (mode === 'unknown') document.unrecognized = { value: 'PRIVATE_PAYLOAD_CANARY' };
    if (mode === 'missing') delete qemu.cpu_features;
    if (mode === 'scalar-type') qemu.cpu_features = 1n;
    if (mode === 'date') qemu.cpu_features = new Date('2026-01-01T00:00:00Z');
  }
}
class RuntimePolicyIntegration {
  private readonly fixture = new RuntimePolicyFixture();
  private original = '';
  async prepare(): Promise<void> {
    RuntimePolicyFixture.type();
    await this.fixture.prepare();
    this.original = this.fixture.text;
  }
  reset(): void {
    if (!this.original) return;
    rmSync(this.fixture.configuration.path, { force: true });
    this.fixture.write(this.original);
  }
  release(): void {
    for (const policy of this.fixture.held) policy.close();
    this.fixture.held.length = 0;
  }
  close(): void {
    this.fixture.close();
  }
  private safe(error: unknown): boolean {
    assert(error instanceof Error);
    assert.equal(error.message, 'KATA_RUNTIME_POLICY_INVALID');
    assert(!String(error).includes('PRIVATE_'));
    assert.equal(Reflect.get(error, 'cause'), undefined);
    return true;
  }
  async configuration(mode: string): Promise<void> {
    this.fixture.write(EffectivePolicyMutations.text(this.original, mode));
    await assert.rejects(this.fixture.open(), this.safe.bind(this));
    this.fixture.components!.verify();
    this.fixture.aliases!.verify();
  }
  async filesystem(mode: string): Promise<void> {
    const fixture = this.fixture,
      input = fixture.input;
    this.changeFile(mode);
    const before = readdirSync('/proc/self/fd').length;
    try {
      await assert.rejects(fixture.open(input), this.safe.bind(this));
      assert.equal(readdirSync('/proc/self/fd').length, before);
    } finally {
      chmodSync(fixture.directory, 0o700);
    }
    fixture.components!.verify();
  }
  private changeFile(mode: string): void {
    const file = this.fixture.configuration.path;
    if (mode === 'bytes') appendFileSync(file, 'PRIVATE_BYTES_CANARY');
    if (mode === 'mode') chmodSync(file, 0o644);
    if (mode === 'special-mode') chmodSync(file, 0o4600);
    if (mode === 'parent-special-mode') chmodSync(this.fixture.directory, 0o1700);
    if (mode === 'parent-mode') chmodSync(this.fixture.directory, 0o755);
    if (mode === 'symlink') {
      rmSync(file);
      symlinkSync('/PRIVATE_EXTERNAL_CANARY', file);
    }
  }
  async changed(): Promise<void> {
    const policy = await this.fixture.open();
    appendFileSync(this.fixture.configuration.path, '# PRIVATE_CHANGED_CANARY');
    assert.throws(policy.verify.bind(policy), { message: 'KATA_RUNTIME_POLICY_CHANGED' });
    policy.close();
    assert.throws(policy.verify.bind(policy), { message: 'KATA_RUNTIME_POLICY_CLOSED' });
    this.fixture.aliases!.verify();
  }
  async cancelled(): Promise<void> {
    const controller = new AbortController(),
      before = readdirSync('/proc/self/fd').length;
    const pending = this.fixture.open(this.fixture.input, controller.signal);
    controller.abort();
    await assert.rejects(pending, { message: 'KATA_CANCELLED' });
    assert.equal(readdirSync('/proc/self/fd').length, before);
    this.fixture.components!.verify();
  }
  async snapshot(): Promise<void> {
    const input = {
      configuration: { ...this.fixture.configuration },
      resources: { ...this.fixture.resources },
    };
    const pending = this.fixture.open(input);
    input.configuration.path = '/PRIVATE_MUTATION_CANARY';
    input.resources.vcpus = 42;
    const policy = await pending;
    assert.equal(policy.proof.configuration.sha256, this.fixture.configuration.sha256);
    assert.deepEqual(policy.proof.resources, this.fixture.resources);
    policy.verify();
  }
  async getter(): Promise<void> {
    let calls = 0;
    const getter = new PolicyGetter();
    const input = Object.defineProperty({}, 'configuration', {
      enumerable: true,
      get: getter.read.bind(getter),
    });
    await assert.rejects(this.fixture.open(input), this.safe.bind(this));
    assert.equal(getter.calls, calls);
  }
  async failedDisposal(kind: string): Promise<void> {
    const before = this.descriptors();
    const policy = await this.fixture.open();
    const path = kind === 'file' ? this.fixture.configuration.path : this.fixture.directory;
    const borrowed = this.withdraw(path, before);
    try {
      assert.throws(policy.close.bind(policy), /KATA_RUNTIME_POLICY_CLOSE_FAILED/);
      assert.throws(policy.close.bind(policy), /KATA_RUNTIME_POLICY_CLOSE_FAILED/);
      this.fixture.held.length = 0;
      assert(fstatSync(borrowed).isFile());
      this.fixture.aliases!.verify();
    } finally {
      this.releaseDescriptor(borrowed);
    }
  }
  private descriptors(): Set<string> {
    const result = new Set<string>();
    for (const entry of readdirSync('/proc/self/fd')) {
      try {
        readlinkSync('/proc/self/fd/' + entry);
        result.add(entry);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return result;
  }
  private retained(path: string, before: Set<string>): number {
    for (const entry of readdirSync('/proc/self/fd')) {
      if (before.has(entry)) continue;
      try {
        if (readlinkSync('/proc/self/fd/' + entry) === path) return Number(entry);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    throw new Error('Missing retained effective policy descriptor');
  }
  private withdraw(path: string, before: Set<string>): number {
    const owned = this.retained(path, before);
    closeSync(owned);
    const borrowed = openSync(this.fixture.components!.bindings[0]!.path, 'r');
    assert.equal(borrowed, owned);
    return borrowed;
  }
  private releaseDescriptor(fd: number): void {
    try {
      fstatSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EBADF') return;
      throw error;
    }
    closeSync(fd);
  }
  async disposal(): Promise<void> {
    const before = readdirSync('/proc/self/fd').length,
      policy = await this.fixture.open();
    policy.close();
    policy.close();
    assert.equal(readdirSync('/proc/self/fd').length, before);
    assert.throws(policy.verify.bind(policy), { message: 'KATA_RUNTIME_POLICY_CLOSED' });
    this.fixture.aliases!.verify();
    this.fixture.components!.verify();
    this.fixture.archive!.verify();
  }
}
class PolicyGetter {
  calls = 0;
  read(): never {
    this.calls++;
    throw new Error('PRIVATE_GETTER_CANARY');
  }
}
const suite = new RuntimePolicyIntegration();
beforeAll(suite.prepare.bind(suite), 300000);
beforeEach(suite.reset.bind(suite));
afterEach(suite.release.bind(suite));
afterAll(suite.close.bind(suite));
for (const mode of [
  'zero-cpu-max',
  'excess-cpu-max',
  'missing-overhead',
  'zero-memory-max',
  'excess-memory-max',
  'slots',
  'dynamic-resources',
  'nonfinite',
  'annotations',
  'hook',
  'kernel',
  'network',
  'debug',
  'security',
  'command',
  'unknown',
  'missing',
  'scalar-type',
  'date',
  'float',
  'duplicate',
])
  test(
    'integration: full effective runtime policy rejects ' +
      mode +
      ' without admitting unused options',
    suite.configuration.bind(suite, mode),
  );
for (const mode of ['bytes', 'mode', 'special-mode', 'parent-mode', 'parent-special-mode', 'symlink'])
  test(
    'integration: effective runtime file custody rejects ' + mode + ' without leaking descriptors',
    suite.filesystem.bind(suite, mode),
  );
test(
  'integration: retained effective runtime file changes fence reuse and preserve borrowed custody',
  suite.changed.bind(suite),
);
test(
  'integration: effective runtime policy cancellation drains owned admission descriptors',
  suite.cancelled.bind(suite),
);
test(
  'integration: effective runtime policy snapshots caller input before asynchronous admission',
  suite.snapshot.bind(suite),
);
test(
  'integration: effective runtime policy rejects accessors without invoking their behavior',
  suite.getter.bind(suite),
);
test(
  'integration: effective runtime policy disposal is idempotent and closes only owned descriptors',
  suite.disposal.bind(suite),
);

for (const kind of ['file', 'parent'])
  test(
    'integration: failed effective policy disposal preserves reused ' +
      kind +
      ' descriptors and stays failed',
    suite.failedDisposal.bind(suite, kind),
  );

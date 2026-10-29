import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { CanonicalJson, SandboxControlSchemas } from '@treeseed-cordis/sdk';
import * as Sandbox from '@treeseed-cordis/deployment/sandbox';
import { RuntimePolicyFixture } from './runtime-policy-program.js';
import { PrivateKataFixture } from './kata-backend-program.js';

interface LaunchProof {
  readonly kind: 'kata-launch-binding';
  readonly formatVersion: 1;
  readonly policyDigest: string;
  readonly boot: Sandbox.SandboxBootObservation;
  readonly machine: Readonly<{ type: 'q35'; accelerator: 'kvm' }>;
  readonly digest: string;
}
export interface LaunchAttestation {
  readonly proof: LaunchProof;
  verify(): void;
  close(): void;
}
interface LaunchConstructor {
  open(policy: unknown, name: unknown, signal: AbortSignal): Promise<LaunchAttestation>;
}
export class LaunchCapability {
  static type(): LaunchConstructor {
    const Constructor = Reflect.get(Sandbox, 'KataLaunchAttestation') as LaunchConstructor;
    assert(
      Constructor && typeof Constructor.open === 'function',
      'Public native launch attestation missing',
    );
    return Constructor;
  }
}
/** Hosted fixture retains installed members; it never extracts or edits the installed kit. */
class InstalledPolicyFixture {
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
      const member = inspected.members.find(InstalledPolicyFixture.requested.bind(null, requested));
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
class NativeLaunchScenario {
  private readonly fixture = new PrivateKataFixture();
  private readonly custody = new InstalledPolicyFixture(this.fixture.directory);
  private backend: Sandbox.KataSandboxBackend | null = null;
  private attestation: LaunchAttestation | null = null;
  private active = false;
  private readonly previous = process.env.KATA_CONF_FILE;
  constructor(private readonly id: string) {}
  async run(): Promise<void> {
    const failures = [];
    try {
      await this.exercise();
    } catch (error) {
      this.explain();
      failures.push(error);
    }
    try {
      await this.dispose();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, 'Native launch qualification failed');
  }
  private explain(): void {
    try {
      process.stderr.write('Isolated native launch daemon tail:\n' + this.daemonTail() + '\n');
    } catch {
      process.stderr.write('Isolated native launch daemon tail unavailable\n');
    }
  }
  private daemonTail(): string {
    const fd = openSync(join(this.fixture.directory, 'daemon.log'), 'r');
    try {
      const size = fstatSync(fd).size,
        bytes = Buffer.alloc(Math.min(16384, size));
      const count = readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
      return bytes.subarray(0, count).toString('utf8');
    } finally {
      closeSync(fd);
    }
  }
  private async exercise(): Promise<void> {
    const path = await this.custody.prepare();
    process.env.KATA_CONF_FILE = path;
    await this.fixture.start();
    const selected = (await this.fixture.configuration()) as Record<string, unknown>;
    this.fixture.run(['images', 'pull', '--platform', 'linux/amd64', selected.image as string]);
    this.backend = await Sandbox.KataSandboxBackend.open({
      ...selected,
      resources: this.custody.resources,
    });
    this.active = true;
    const created = await this.backend.create(this.id, this.custody.signal);
    await this.attest(created);
    await this.destroy();
    assert.throws(this.attestation!.verify.bind(this.attestation), {
      message: 'KATA_LAUNCH_CHANGED',
    });
  }
  private async attest(created: Sandbox.KataSandboxEvidence): Promise<void> {
    const Constructor = LaunchCapability.type(),
      policy = this.custody.policy!;
    this.observed(created);
    this.attestation = await Constructor.open(policy, created.resourceName, this.custody.signal);
    this.attestation.verify();
    this.proof(created);
    await this.repeated(created);
    await this.refused(created);
    await this.mismatched(created);
    this.attestation.verify();
  }
  private async mismatched(created: Sandbox.KataSandboxEvidence): Promise<void> {
    const alternate = await this.custody.mismatch(),
      Constructor = LaunchCapability.type();
    try {
      await assert.rejects(
        Constructor.open.bind(Constructor, alternate, created.resourceName, this.custody.signal),
        { message: 'KATA_LAUNCH_INVALID' },
      );
    } finally {
      alternate.close();
    }
  }
  private async repeated(created: Sandbox.KataSandboxEvidence): Promise<void> {
    const repeated = await LaunchCapability.type().open(
      this.custody.policy!,
      created.resourceName,
      this.custody.signal,
    );
    try {
      assert.deepEqual(repeated.proof, this.attestation!.proof);
    } finally {
      repeated.close();
    }
    assert.throws(repeated.verify.bind(repeated), { message: 'KATA_LAUNCH_CLOSED' });
    repeated.close();
    this.custody.policy!.verify();
  }
  private async refused(created: Sandbox.KataSandboxEvidence): Promise<void> {
    const Constructor = LaunchCapability.type(),
      policy = this.custody.policy!;
    await assert.rejects(
      Constructor.open.bind(Constructor, policy, created.resourceName, AbortSignal.abort()),
      { message: 'KATA_CANCELLED' },
    );
    await assert.rejects(
      Constructor.open.bind(Constructor, policy, '../PRIVATE_NAME', this.custody.signal),
      { message: 'KATA_LAUNCH_INVALID' },
    );
  }
  private proof(created: Sandbox.KataSandboxEvidence): void {
    const proof = this.attestation!.proof,
      { digest, ...payload } = proof;
    assert.equal(payload.kind, 'kata-launch-binding');
    assert.equal(payload.policyDigest, this.custody.policy!.proof.digest);
    assert.deepEqual(payload.boot, created.boot);
    assert.deepEqual(payload.machine, { type: 'q35', accelerator: 'kvm' });
    assert.equal(digest, CanonicalJson.digest(payload));
    assert(Object.isFrozen(proof) && Object.isFrozen(payload.machine));
  }
  private observed(created: Sandbox.KataSandboxEvidence): void {
    assert.deepEqual(created.boot.boot.resources, {
      vcpus: 3,
      maximumVcpus: 3,
      memoryMiB: 1056,
      maximumMemoryMiB: 1312,
    });
  }
  private async destroy(): Promise<void> {
    if (!this.backend || !this.active) return;
    await this.backend.destroy(this.id, this.custody.signal);
    this.active = false;
  }
  private closeAttestation(): void {
    this.attestation?.close();
  }
  private async closeBackend(): Promise<void> {
    await this.backend?.close();
  }
  private restore(): void {
    if (this.previous === undefined) delete process.env.KATA_CONF_FILE;
    else process.env.KATA_CONF_FILE = this.previous;
  }
  private async dispose(): Promise<void> {
    const failures = [];
    for (const release of [
      this.closeAttestation.bind(this),
      this.destroy.bind(this),
      this.closeBackend.bind(this),
      this.fixture.stop.bind(this.fixture),
      this.custody.close.bind(this.custody),
      this.restore.bind(this),
    ])
      try {
        await release();
      } catch (error) {
        failures.push(error);
      }
    if (failures.length) throw new AggregateError(failures, 'Native launch cleanup failed');
  }
}
class LaunchProgram {
  static async run(): Promise<void> {
    const Constructor = LaunchCapability.type();
    const id = SandboxControlSchemas.sandboxId.parse('sandbox-' + randomUUID());
    if (process.argv[2] === '--interface') {
      await assert.rejects(
        Constructor.open.bind(Constructor, {}, 'fixture', new AbortController().signal),
        { message: 'KATA_LAUNCH_INVALID' },
      );
      process.stdout.write('kata-launch-interface-ok\n');
    } else {
      await new NativeLaunchScenario(id).run();
      process.stdout.write('kata-launch-binding-public-ok\n');
    }
  }
}
if (import.meta.main) await LaunchProgram.run();

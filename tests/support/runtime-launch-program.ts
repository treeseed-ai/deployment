import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CanonicalJson, SandboxControlSchemas } from '@treeseed-cordis/sdk';
import * as Sandbox from '@treeseed-cordis/deployment/sandbox';
import { NativePolicyFixture } from './runtime-task-program.js';
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
class NativeLaunchScenario {
  private readonly fixture = new PrivateKataFixture();
  private readonly custody = new NativePolicyFixture(this.fixture.directory);
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
      failures.push(error);
    }
    try {
      await this.dispose();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, 'Native launch qualification failed');
  }
  private async exercise(): Promise<void> {
    const path = await this.custody.prepare();
    process.env.KATA_CONF_FILE = path;
    await this.fixture.start('task-options');
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

import { parse } from 'smol-toml';
import { z } from 'zod';
import { basename, dirname, resolve } from 'node:path';
import { PlatformSchemas } from '@treeseed-cordis/sdk';
import { SafeDirectory } from './filesystem.js';
import { KataSandboxError } from './kata-command.js';
import { RuntimeComponentCustody, type RuntimeComponentProof } from './runtime-components.js';
import type { RuntimeKitMember } from './runtime-kit.js';
export interface KataRuntimeReferences {
  readonly kind: 'kata-runtime-references';
  readonly formatVersion: 1;
  readonly archive: RuntimeComponentProof['archive'];
  readonly configuration: RuntimeKitMember;
  readonly references: readonly Readonly<{ role: string; member: RuntimeKitMember }>[];
  readonly resources: Readonly<{
    defaultVcpus: number;
    maximumVcpus: number;
    defaultMemoryMiB: number;
    maximumMemoryMiB: number;
    overheadVcpus: number;
    overheadMemoryMiB: number;
    memorySlots: number;
    staticSandboxResourceManagement: boolean;
  }>;
}
/** Pure interpretation; full byte identity is retained even for uninterpreted options. */
export class RuntimeConfigurationProjection {
  private static readonly roles = ['hypervisor', 'kernel', 'rootfs', 'virtiofs'] as const;
  private static readonly fields = ['path', 'kernel', 'image', 'virtio_fs_daemon'] as const;
  parse(text: string, proof: RuntimeComponentProof): KataRuntimeReferences {
    try {
      const document = parse(text, {
        integersAsBigInt: true,
        unsafeKeyBehaviour: 'throw',
        maxDepth: 32,
      });
      this.finite(document);
      const hypervisors = this.table(document.hypervisor);
      this.require(Object.keys(hypervisors).length === 1);
      const qemu = this.table(hypervisors.qemu),
        runtime = this.table(document.runtime);
      const agents = this.table(document.agent);
      this.require(Object.keys(agents).length === 1);
      this.table(agents.kata);
      this.require(runtime.hypervisor_name === 'qemu' && runtime.agent_name === 'kata');
      return this.projection(qemu, runtime, proof);
    } catch {
      throw new KataSandboxError('KATA_CONFIGURATION_INVALID');
    }
  }
  private require(value: unknown): asserts value {
    KataSandboxError.require(value, 'KATA_CONFIGURATION_INVALID');
  }
  private table(value: unknown): Record<string, unknown> {
    this.require(value !== null && typeof value === 'object' && !Array.isArray(value));
    this.require(
      Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    );
    return value as Record<string, unknown>;
  }
  private finite(document: unknown): void {
    const pending = [document];
    let count = 0;
    while (pending.length) {
      const value = pending.pop();
      this.require(++count <= 65536);
      if (typeof value === 'number') this.require(Number.isFinite(value));
      if (value && typeof value === 'object') pending.push(...Object.values(value));
    }
  }
  private member(proof: RuntimeComponentProof, role: string): RuntimeKitMember {
    const matches = [];
    for (const component of proof.components)
      if (component.role === role) matches.push(component.member);
    this.require(matches.length === 1);
    return this.freeze(structuredClone(matches[0]!));
  }
  private freeze(member: RuntimeKitMember): RuntimeKitMember {
    for (const link of member.links) Object.freeze(link);
    Object.freeze(member.links);
    return Object.freeze(member);
  }
  private reference(value: unknown, member: RuntimeKitMember): void {
    this.require(typeof value === 'string' && value.startsWith('/'));
    this.require(resolve(value) === value);
    const allowed = new Set([member.requestedPath, member.path]);
    for (const link of member.links) allowed.add(link.path);
    this.require(allowed.has(value.slice(1)));
  }
  private projection(
    qemu: Record<string, unknown>,
    runtime: Record<string, unknown>,
    proof: RuntimeComponentProof,
  ): KataRuntimeReferences {
    const references = [];
    for (const [index, role] of RuntimeConfigurationProjection.roles.entries()) {
      const member = this.member(proof, role);
      this.reference(qemu[RuntimeConfigurationProjection.fields[index]!], member);
      references.push(Object.freeze({ role, member }));
    }
    return Object.freeze({
      kind: 'kata-runtime-references',
      formatVersion: 1,
      archive: Object.freeze({ ...proof.archive }),
      configuration: this.member(proof, 'configuration'),
      references: Object.freeze(references),
      resources: this.resources(qemu, runtime),
    });
  }
  private integer(value: unknown, minimum: number): number {
    this.require(
      typeof value === 'bigint' &&
        value >= BigInt(minimum) &&
        value <= BigInt(Number.MAX_SAFE_INTEGER),
    );
    return Number(value);
  }
  private cpu(value: unknown): number {
    if (typeof value === 'bigint') return this.integer(value, 0);
    this.require(
      typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= Number.MAX_SAFE_INTEGER,
    );
    return value;
  }
  private resources(
    qemu: Record<string, unknown>,
    runtime: Record<string, unknown>,
  ): KataRuntimeReferences['resources'] {
    const defaultVcpus = this.integer(qemu.default_vcpus, 1),
      maximumVcpus = this.integer(qemu.default_maxvcpus, 0);
    const defaultMemoryMiB = this.integer(qemu.default_memory, 1),
      maximumMemoryMiB = this.integer(qemu.default_maxmemory, 0);
    this.require(maximumVcpus === 0 || maximumVcpus >= defaultVcpus);
    this.require(maximumMemoryMiB === 0 || maximumMemoryMiB >= defaultMemoryMiB);
    this.require(typeof runtime.static_sandbox_resource_mgmt === 'boolean');
    return Object.freeze({
      defaultVcpus,
      maximumVcpus,
      defaultMemoryMiB,
      maximumMemoryMiB,
      overheadVcpus: this.cpu(qemu.overhead_vcpus),
      overheadMemoryMiB: this.integer(qemu.overhead_memory, 0),
      memorySlots: this.integer(qemu.memory_slots, 1),
      staticSandboxResourceManagement: runtime.static_sandbox_resource_mgmt,
    });
  }
}
/** Borrowed component custody, descriptor-anchored bounded bytes, no host activation. */
export class KataRuntimeConfiguration {
  static readonly Config = z.strictObject({
    path: PlatformSchemas.absolute,
    sha256: PlatformSchemas.digest,
  });
  static async inspect(
    input: unknown,
    components: RuntimeComponentCustody,
    signal: AbortSignal,
  ): Promise<KataRuntimeReferences> {
    try {
      signal.throwIfAborted();
      KataSandboxError.require(
        components instanceof RuntimeComponentCustody,
        'KATA_CONFIGURATION_INVALID',
      );
      components.verify();
      const file = this.Config.parse(input);
      KataSandboxError.require(resolve(file.path) === file.path, 'KATA_CONFIGURATION_INVALID');
      const proof = new RuntimeConfigurationProjection().parse(this.read(file), components.proof);
      KataSandboxError.require(
        proof.configuration.sha256 === file.sha256,
        'KATA_CONFIGURATION_INVALID',
      );
      components.verify();
      signal.throwIfAborted();
      return proof;
    } catch {
      throw new KataSandboxError(signal.aborted ? 'KATA_CANCELLED' : 'KATA_CONFIGURATION_INVALID');
    }
  }
  private static read(file: z.infer<typeof this.Config>): string {
    const directory = SafeDirectory.open(dirname(file.path));
    try {
      const bytes = directory.file(basename(file.path), file.sha256, 1024 * 1024);
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } finally {
      directory.close();
    }
  }
}

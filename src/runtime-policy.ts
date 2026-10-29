import { z } from 'zod';
import { parse } from 'smol-toml';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readSync,
  type Stats,
} from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import {
  CanonicalJson,
  PlatformSchemas,
  PoolSchemas,
  type PoolResourceShape,
} from '@treeseed-cordis/sdk';
import { SafeDirectory } from './filesystem.js';
import { KataSandboxError } from './kata-command.js';
import { RuntimeComponentCustody, type RuntimeComponentProof } from './runtime-components.js';
import { RuntimeAliasCustody, RuntimeDirectoryAnchor } from './runtime-aliases.js';
import { RuntimeConfigurationProjection } from './kata-configuration.js';
import type { RuntimeKitMember } from './runtime-kit.js';
type Table = Record<string, unknown>;
export interface EffectiveRuntimePolicyProof {
  readonly kind: 'kata-effective-runtime-policy';
  readonly formatVersion: 1;
  readonly archive: Readonly<{ sha256: string; size: number }>;
  readonly template: RuntimeKitMember;
  readonly configuration: Readonly<{ sha256: string; size: number }>;
  readonly installationRoot: string;
  readonly components: RuntimeComponentProof['components'];
  readonly bindings: RuntimeComponentCustody['bindings'];
  readonly aliasesDigest: string;
  readonly resources: PoolResourceShape;
  readonly vmResources: Readonly<{
    vcpus: number;
    maximumVcpus: number;
    memoryMiB: number;
    maximumMemoryMiB: number;
  }>;
  readonly digest: string;
}
class PolicyAdmission {
  static readonly Config = z.strictObject({
    configuration: z.strictObject({
      path: PlatformSchemas.absolute,
      sha256: PlatformSchemas.digest,
    }),
    resources: PoolSchemas.resources,
  });
  static parse(input: unknown): z.infer<typeof this.Config> {
    const record = this.record(input);
    this.record(record.configuration);
    this.record(record.resources);
    const selected = this.Config.parse(record);
    if (
      resolve(selected.configuration.path) !== selected.configuration.path ||
      selected.configuration.path.length > 4096
    )
      throw new Error();
    return selected;
  }
  private static record(input: unknown): Table {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const entries = Object.getOwnPropertyDescriptors(input);
    if (Object.keys(entries).length > 16 || Object.getOwnPropertySymbols(input).length)
      throw new Error();
    for (const [key, descriptor] of Object.entries(entries))
      if (
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value') ||
        key === '__proto__' ||
        key === 'constructor' ||
        key === 'prototype'
      )
        throw new Error();
    return input as Table;
  }
}
/** Small private configuration bytes, held separately from the immutable kit template. */
class EffectivePolicyFile {
  private closed = false;
  private closeFailed = false;
  private static readonly keys = [
    'dev',
    'ino',
    'size',
    'mode',
    'uid',
    'gid',
    'nlink',
    'mtimeMs',
    'ctimeMs',
  ] as const;
  private constructor(
    private readonly parent: RuntimeDirectoryAnchor,
    private readonly name: string,
    private readonly fd: number,
    private readonly identity: Stats,
  ) {}
  static open(path: string): EffectivePolicyFile {
    const parent = RuntimeDirectoryAnchor.open(dirname(path));
    let file: EffectivePolicyFile | null = null;
    try {
      const stat = fstatSync(parent.directory.fd);
      if (stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700) throw new Error();
      file = this.capture(parent, basename(path));
      file.verify();
      return file;
    } catch (error) {
      try {
        if (file) file.close();
        else parent.close();
      } catch {}
      throw error;
    }
  }
  private static capture(parent: RuntimeDirectoryAnchor, name: string): EffectivePolicyFile {
    const fd = openSync(
      parent.directory.childPath(name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      return new EffectivePolicyFile(parent, name, fd, fstatSync(fd));
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  private same(stat: Stats): boolean {
    for (const key of EffectivePolicyFile.keys) if (stat[key] !== this.identity[key]) return false;
    return true;
  }
  verify(): void {
    if (this.closed) throw new Error();
    this.parent.verify();
    const held = fstatSync(this.fd),
      linked = lstatSync(this.parent.directory.childPath(this.name));
    if (
      !held.isFile() ||
      linked.isSymbolicLink() ||
      held.nlink !== 1 ||
      held.uid !== process.getuid?.() ||
      (held.mode & 0o7777) !== 0o600 ||
      held.size < 1 ||
      held.size > 1048576 ||
      !this.same(held) ||
      !this.same(linked)
    )
      throw new Error();
  }
  bytes(expected: string): Buffer {
    this.verify();
    const bytes = Buffer.alloc(this.identity.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(this.fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error();
      offset += count;
    }
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error();
    this.verify();
    return bytes;
  }
  private releaseFile(): void {
    const stat = fstatSync(this.fd);
    if (!stat.isFile() || stat.dev !== this.identity.dev || stat.ino !== this.identity.ino)
      throw new Error();
    closeSync(this.fd);
  }
  private release(): void {
    let failed = false;
    try {
      this.releaseFile();
    } catch {
      failed = true;
    }
    try {
      this.parent.close();
    } catch {
      failed = true;
    }
    if (failed) throw new Error();
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      try {
        this.release();
      } catch {
        this.closeFailed = true;
      }
    }
    if (this.closeFailed) throw new Error();
  }
}
/** Preserve TOML scalar types; integers are never confused with strings or floats. */
class TomlIdentity {
  private count = 0;
  static canonical(value: unknown): string {
    return CanonicalJson.stringify(new TomlIdentity().value(value, 0));
  }
  private value(value: unknown, depth: number): unknown {
    if (++this.count > 65536 || depth > 32) throw new Error();
    if (typeof value === 'string') return ['string', value];
    if (typeof value === 'boolean') return ['boolean', value];
    if (typeof value === 'bigint') return ['integer', value.toString()];
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error();
      return ['float', value];
    }
    if (Array.isArray(value)) return this.array(value, depth);
    return this.table(value, depth);
  }
  private array(value: unknown[], depth: number): unknown {
    const entries = [];
    for (const item of value) entries.push(this.value(item, depth + 1));
    return ['array', entries];
  }
  private table(value: unknown, depth: number): unknown {
    if (!value || typeof value !== 'object') throw new Error();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const entries = [];
    for (const key of Object.keys(value).sort())
      entries.push([key, this.value(Reflect.get(value, key), depth + 1)]);
    return ['table', entries];
  }
}
class EffectivePolicyProjection {
  private static readonly archive = {
    sha256: '3dc6b69c4acb787b967b04b64599a20d02a8beb1a8eaab3084110df9d0b08c96',
    size: 969565384,
  };
  private static readonly template = {
    path: 'opt/kata/share/defaults/kata-containers/runtime-rs/configuration-qemu-runtime-rs.toml',
    sha256: '870f8157d298a51784d3617854456edf16820bbc1e743b15467e441b63c43673',
  };
  static project(
    bytes: Buffer,
    components: RuntimeComponentCustody,
    aliases: RuntimeAliasCustody,
    resources: PoolResourceShape,
  ): EffectiveRuntimePolicyProof {
    this.kit(components, aliases);
    const template = this.templateMember(components);
    const original = this.readTemplate(components, template);
    const references = new RuntimeConfigurationProjection().parse(original, components.proof);
    const vmResources = this.vm(resources, references.resources);
    this.compare(original, bytes, vmResources);
    const payload = Object.freeze({
      kind: 'kata-effective-runtime-policy' as const,
      formatVersion: 1 as const,
      archive: components.proof.archive,
      template,
      configuration: this.configuration(bytes),
      installationRoot: aliases.proof.installationRoot,
      components: components.proof.components,
      bindings: components.bindings,
      aliasesDigest: aliases.proof.digest,
      resources: Object.freeze({ ...resources }),
      vmResources,
    });
    return Object.freeze({ ...payload, digest: CanonicalJson.digest(payload) });
  }
  private static configuration(bytes: Buffer): EffectiveRuntimePolicyProof['configuration'] {
    return Object.freeze({
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  private static kit(components: RuntimeComponentCustody, aliases: RuntimeAliasCustody): void {
    if (
      CanonicalJson.stringify(components.proof.archive) !== CanonicalJson.stringify(this.archive) ||
      CanonicalJson.stringify(aliases.proof.archive) !== CanonicalJson.stringify(this.archive) ||
      CanonicalJson.stringify(aliases.proof.bindings) !==
        CanonicalJson.stringify(components.bindings)
    )
      throw new Error();
    const roles = [];
    for (const binding of components.bindings) roles.push(binding.role);
    if (roles.join(',') !== 'configuration,hypervisor,kernel,rootfs,shim,virtiofs')
      throw new Error();
  }
  private static templateMember(components: RuntimeComponentCustody): RuntimeKitMember {
    const selected = components.proof.components[0];
    if (
      !selected ||
      selected.role !== 'configuration' ||
      selected.member.path !== this.template.path ||
      selected.member.requestedPath !== this.template.path ||
      selected.member.sha256 !== this.template.sha256
    )
      throw new Error();
    return selected.member;
  }
  private static readTemplate(
    components: RuntimeComponentCustody,
    member: RuntimeKitMember,
  ): string {
    const binding = components.bindings[0]!;
    const directory = SafeDirectory.open(dirname(binding.path));
    try {
      const bytes = directory.file(basename(binding.path), member.sha256, 1048576);
      components.verify();
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } finally {
      directory.close();
    }
  }
  private static vm(
    resources: PoolResourceShape,
    template: ReturnType<RuntimeConfigurationProjection['parse']>['resources'],
  ): EffectiveRuntimePolicyProof['vmResources'] {
    if (!template.staticSandboxResourceManagement) throw new Error();
    const vcpus = Math.ceil(resources.vcpus + template.overheadVcpus);
    const memoryMiB = resources.memoryMiB + template.overheadMemoryMiB;
    if (
      !Number.isSafeInteger(vcpus) ||
      vcpus < 1 ||
      vcpus > 4096 ||
      !Number.isSafeInteger(memoryMiB) ||
      memoryMiB < 128 ||
      memoryMiB > 16 * 1024 * 1024
    )
      throw new Error();
    return Object.freeze({ vcpus, maximumVcpus: vcpus, memoryMiB, maximumMemoryMiB: memoryMiB });
  }
  private static document(text: string): Table {
    const document = parse(text, {
      integersAsBigInt: true,
      unsafeKeyBehaviour: 'throw',
      maxDepth: 32,
    });
    TomlIdentity.canonical(document);
    return document;
  }
  private static compare(
    original: string,
    bytes: Buffer,
    resources: EffectiveRuntimePolicyProof['vmResources'],
  ): void {
    const expected = this.document(original),
      qemu = (expected.hypervisor as Table).qemu as Table;
    qemu.default_vcpus = BigInt(resources.vcpus);
    qemu.default_maxvcpus = BigInt(resources.maximumVcpus);
    qemu.default_memory = BigInt(resources.memoryMiB);
    qemu.default_maxmemory = BigInt(resources.maximumMemoryMiB);
    qemu.memory_slots = 1n;
    qemu.enable_annotations = [];
    const actual = this.document(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (TomlIdentity.canonical(expected) !== TomlIdentity.canonical(actual)) throw new Error();
  }
}
/** Borrowed verified kit/aliases, owned immutable effective file; never runtime activation. */
export class EffectiveRuntimePolicy {
  static readonly Config = PolicyAdmission.Config;
  private closed = false;
  private closeFailed = false;
  private constructor(
    private readonly components: RuntimeComponentCustody,
    private readonly aliases: RuntimeAliasCustody,
    private readonly file: EffectivePolicyFile,
    readonly proof: EffectiveRuntimePolicyProof,
  ) {}
  static async open(
    input: unknown,
    components: RuntimeComponentCustody,
    aliases: RuntimeAliasCustody,
    signal: AbortSignal,
  ): Promise<EffectiveRuntimePolicy> {
    let policy: EffectiveRuntimePolicy | null = null;
    try {
      signal.throwIfAborted();
      policy = this.capture(input, components, aliases);
      await setImmediate();
      signal.throwIfAborted();
      policy.verify();
      return policy;
    } catch {
      try {
        policy?.close();
      } catch {}
      throw new KataSandboxError(signal.aborted ? 'KATA_CANCELLED' : 'KATA_RUNTIME_POLICY_INVALID');
    }
  }
  private static capture(
    input: unknown,
    components: RuntimeComponentCustody,
    aliases: RuntimeAliasCustody,
  ): EffectiveRuntimePolicy {
    const selected = PolicyAdmission.parse(input);
    this.borrowed(components, aliases);
    const file = EffectivePolicyFile.open(selected.configuration.path);
    try {
      const proof = EffectivePolicyProjection.project(
        file.bytes(selected.configuration.sha256),
        components,
        aliases,
        selected.resources,
      );
      return new EffectiveRuntimePolicy(components, aliases, file, proof);
    } catch (error) {
      try {
        file.close();
      } catch {}
      throw error;
    }
  }
  private static borrowed(components: RuntimeComponentCustody, aliases: RuntimeAliasCustody): void {
    if (
      !(components instanceof RuntimeComponentCustody) ||
      !(aliases instanceof RuntimeAliasCustody)
    )
      throw new Error();
    components.verify();
    aliases.verify();
  }
  verify(): void {
    KataSandboxError.require(!this.closed, 'KATA_RUNTIME_POLICY_CLOSED');
    try {
      this.components.verify();
      this.aliases.verify();
      this.file.verify();
      this.components.verify();
    } catch {
      throw new KataSandboxError('KATA_RUNTIME_POLICY_CHANGED');
    }
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      try {
        this.file.close();
      } catch {
        this.closeFailed = true;
      }
    }
    KataSandboxError.require(!this.closeFailed, 'KATA_RUNTIME_POLICY_CLOSE_FAILED');
  }
}
export type EffectiveRuntimePolicyInput = z.infer<typeof EffectiveRuntimePolicy.Config>;

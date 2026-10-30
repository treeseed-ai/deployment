import { readdirSync, readFileSync, readlinkSync, lstatSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { QemuStartupShape, type SandboxVmStartupShape } from './kata-vm-shape.js';
import { resolve } from 'node:path';
import { CanonicalJson } from '@treeseed-cordis/sdk';
import { setImmediate } from 'node:timers/promises';
import { EffectiveRuntimePolicy, type EffectiveRuntimePolicyProof } from './runtime-policy.js';
import { KataSandboxError } from './kata-command.js';
import type { RuntimeKitMember } from './runtime-kit.js';
export { QemuStartupShape, type SandboxVmStartupShape } from './kata-vm-shape.js';

export interface SandboxBootInputs {
  readonly kernel: string;
  readonly rootfs: Readonly<{ path: string; size: number; driver: 'nvdimm' }>;
  readonly resources: SandboxVmStartupShape;
}
export interface SandboxBootObservation {
  readonly kind: 'kata-boot-observation';
  readonly formatVersion: 1;
  readonly process: Readonly<SandboxProcessIdentity>;
  readonly boot: SandboxBootInputs;
  readonly digest: string;
}
class BootFields {
  static many(args: readonly string[], flag: string): string[] {
    const values = [];
    for (let index = 0; index < args.length; index++)
      if (args[index] === flag) {
        const value = args[index + 1];
        if (!value || value.startsWith('-')) throw new Error();
        values.push(value);
      }
    return values;
  }
  static one(args: readonly string[], flag: string): string {
    const values = this.many(args, flag);
    if (values.length !== 1) throw new Error();
    return values[0]!;
  }
  static fields(text: string, kind: string, allowed: readonly string[]): Map<string, string> {
    const [type, ...entries] = text.split(',');
    if (type !== kind) throw new Error();
    const result = new Map<string, string>();
    for (const entry of entries) {
      const parts = entry.split('='),
        key = parts[0]!,
        value = parts[1];
      if (parts.length !== 2 || !value || !allowed.includes(key) || result.has(key))
        throw new Error();
      result.set(key, value);
    }
    if (result.size !== allowed.length) throw new Error();
    return result;
  }
  static path(value: string): string {
    if (
      !value.startsWith('/') ||
      resolve(value) !== value ||
      value.length > 4096 ||
      value.includes('\0')
    )
      throw new Error();
    return value;
  }
  static bytes(value: string): number {
    const match = /^([1-9][0-9]*)([KMGT]?)$/.exec(value);
    if (!match) throw new Error();
    const units: Record<string, bigint> = {
      '': 1n,
      K: 1024n,
      M: 1048576n,
      G: 1073741824n,
      T: 1099511627776n,
    };
    const bytes = BigInt(match[1]!) * units[match[2]!]!;
    if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error();
    return Number(bytes);
  }
}
/** Syntax projection only; retained policy/custody admission is a separate invariant. */
export class QemuBootProjection {
  parse(args: readonly string[]): SandboxBootInputs {
    try {
      this.bounded(args);
      const kernel = BootFields.path(BootFields.one(args, '-kernel'));
      const rootfs = this.rootfs(args);
      const resources = new QemuStartupShape().parse(args);
      return Object.freeze({ kernel, rootfs, resources });
    } catch {
      throw new Error('SANDBOX_BOOT_UNVERIFIED');
    }
  }
  private bounded(args: readonly string[]): void {
    if (!Array.isArray(args) || args.length > 8192) throw new Error();
    let size = 0;
    for (const value of args) {
      if (typeof value !== 'string' || value.includes('\0')) throw new Error();
      size += Buffer.byteLength(value) + 1;
      if (size > 1048576) throw new Error();
    }
    for (const flag of ['-initrd', '-bios', '-pflash', '-readconfig'])
      if (args.includes(flag)) throw new Error();
  }
  private rootfs(args: readonly string[]): SandboxBootInputs['rootfs'] {
    const device = this.device(args),
      id = device.get('memdev')!;
    const objects = this.objects(args);
    const candidates = [];
    for (const object of objects) if (object.get('id') === id) candidates.push(object);
    if (candidates.length !== 1) throw new Error();
    const backend = candidates[0]!;
    if (
      backend.get('readonly') !== 'on' ||
      backend.get('share') !== 'off' ||
      backend.get('prealloc') !== 'off'
    )
      throw new Error();
    return Object.freeze({
      path: BootFields.path(backend.get('mem-path')!),
      size: BootFields.bytes(backend.get('size')!),
      driver: 'nvdimm' as const,
    });
  }
  private device(args: readonly string[]): Map<string, string> {
    const devices = [];
    for (const value of BootFields.many(args, '-device'))
      if (value.split(',')[0] === 'nvdimm') devices.push(value);
    if (devices.length !== 1) throw new Error();
    const device = BootFields.fields(devices[0]!, 'nvdimm', ['memdev', 'unarmed']);
    if (device.get('unarmed') !== 'on') throw new Error();
    return device;
  }
  private objects(args: readonly string[]): Map<string, string>[] {
    const objects = [],
      identities = new Set<string>();
    for (const value of BootFields.many(args, '-object')) {
      if (value.split(',')[0] !== 'memory-backend-file') continue;
      const fields = BootFields.fields(value, 'memory-backend-file', [
        'id',
        'mem-path',
        'size',
        'share',
        'prealloc',
        'readonly',
      ]);
      if (identities.has(fields.get('id')!)) throw new Error();
      identities.add(fields.get('id')!);
      objects.push(fields);
    }
    return objects;
  }
}

/** Internal pure projection, independently tested; not a configurable accelerator fallback. */
export class NativeLaunchMachine {
  private static readonly required = { accel: 'kvm', nvdimm: 'on', kernel_irqchip: 'on' };
  private static readonly backends = new Set(['entire-guest-memory', 'entire-guest-memory-share']);
  parse(args: readonly string[]): Readonly<{ type: 'q35'; accelerator: 'kvm' }> {
    try {
      if (
        !Array.isArray(args) ||
        args.length > 8192 ||
        args.includes('-M') ||
        args.includes('-accel') ||
        args.some(NativeLaunchMachine.alternate)
      )
        throw new Error();
      const fields = this.fields(BootFields.one(args, '-machine'));
      for (const [key, value] of Object.entries(NativeLaunchMachine.required))
        if (fields.get(key) !== value) throw new Error();
      const backend = fields.get('memory-backend');
      if (backend && !NativeLaunchMachine.backends.has(backend)) throw new Error();
      return Object.freeze({ type: 'q35', accelerator: 'kvm' });
    } catch {
      throw new Error('KATA_LAUNCH_MACHINE_INVALID');
    }
  }
  private static alternate(value: unknown): boolean {
    return typeof value !== 'string' || value.startsWith('--');
  }
  private fields(value: string): Map<string, string> {
    const [kind, ...entries] = value.split(',');
    if (kind !== 'q35') throw new Error();
    const result = new Map<string, string>();
    const allowed = ['accel', 'nvdimm', 'kernel_irqchip', 'memory-backend'];
    for (const entry of entries) {
      const [key, field, extra] = entry.split('=');
      if (!key || !field || extra !== undefined || !allowed.includes(key) || result.has(key))
        throw new Error();
      result.set(key, field);
    }
    return result;
  }
}
export interface KataLaunchProof {
  readonly kind: 'kata-launch-binding';
  readonly formatVersion: 1;
  readonly policyDigest: string;
  readonly boot: SandboxBootObservation;
  readonly machine: Readonly<{ type: 'q35'; accelerator: 'kvm' }>;
  readonly digest: string;
}
class NativeLaunchProjection {
  constructor(private readonly policy: EffectiveRuntimePolicy) {
    if (
      !(policy instanceof EffectiveRuntimePolicy) ||
      process.platform !== 'linux' ||
      process.arch !== 'x64' ||
      policy.proof.installationRoot !== '/'
    )
      throw new Error();
    policy.verify();
  }
  get digest(): string {
    return this.policy.proof.digest;
  }
  observer(): SandboxProcessObserver {
    const binding = this.binding('hypervisor'),
      member = this.member('hypervisor');
    return new SandboxProcessObserver(
      { path: binding.path, sha256: member.sha256 },
      process.getuid!(),
    );
  }
  private binding(role: string): EffectiveRuntimePolicyProof['bindings'][number] {
    for (const binding of this.policy.proof.bindings) if (binding.role === role) return binding;
    throw new Error();
  }
  private member(role: string): RuntimeKitMember {
    for (const component of this.policy.proof.components)
      if (component.role === role) return component.member;
    throw new Error();
  }
  read(
    observer: SandboxProcessObserver,
    expected: SandboxProcessIdentity,
  ): Pick<KataLaunchProof, 'boot' | 'machine'> {
    this.policy.verify();
    const boot = observer.boot(expected);
    this.binary(boot.process);
    this.path('kernel', boot.boot.kernel);
    this.path('rootfs', boot.boot.rootfs.path);
    if (
      boot.boot.rootfs.size !== this.member('rootfs').size ||
      CanonicalJson.stringify(boot.boot.resources) !==
        CanonicalJson.stringify(this.policy.proof.vmResources)
    )
      throw new Error();
    const machine = this.machine(boot.process);
    this.policy.verify();
    if (observer.boot(expected).digest !== boot.digest) throw new Error();
    return { boot, machine };
  }
  private path(role: string, observed: string): void {
    const member = this.member(role),
      paths = new Set([member.requestedPath, member.path]);
    for (const link of member.links) paths.add(link.path);
    if (!paths.has(observed.slice(1)) || !observed.startsWith('/')) throw new Error();
  }
  private binary(identity: SandboxProcessIdentity): void {
    const path = '/proc/' + identity.pid + '/exe',
      selected = this.binding('hypervisor').path;
    if (readlinkSync(path) !== selected) throw new Error();
    const actual = statSync(path),
      retained = lstatSync(selected);
    if (
      !actual.isFile() ||
      !retained.isFile() ||
      actual.dev !== retained.dev ||
      actual.ino !== retained.ino
    )
      throw new Error();
  }
  private machine(identity: SandboxProcessIdentity): KataLaunchProof['machine'] {
    const bytes = readFileSync('/proc/' + identity.pid + '/cmdline');
    if (
      bytes.length > 1048576 ||
      createHash('sha256').update(bytes).digest('hex') !== identity.commandDigest
    )
      throw new Error();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return new NativeLaunchMachine().parse(text.split('\0'));
  }
}
/** Borrowed retained custody and actual process observation, never activation or profile publication. */
export class KataLaunchAttestation {
  private closed = false;
  private constructor(
    private readonly projection: NativeLaunchProjection,
    private readonly observer: SandboxProcessObserver,
    private readonly expected: SandboxProcessIdentity,
    readonly proof: KataLaunchProof,
  ) {}
  static async open(
    policy: EffectiveRuntimePolicy,
    name: string,
    signal: AbortSignal,
  ): Promise<KataLaunchAttestation> {
    let attestation: KataLaunchAttestation | null = null;
    try {
      if (!(signal instanceof AbortSignal)) throw new Error();
      signal.throwIfAborted();
      attestation = this.capture(policy, name);
      await setImmediate();
      signal.throwIfAborted();
      attestation.verify();
      return attestation;
    } catch {
      attestation?.close();
      const cancelled = signal instanceof AbortSignal && signal.aborted;
      throw new KataSandboxError(cancelled ? 'KATA_CANCELLED' : 'KATA_LAUNCH_INVALID');
    }
  }
  private static capture(policy: EffectiveRuntimePolicy, name: string): KataLaunchAttestation {
    const projection = new NativeLaunchProjection(policy);
    if (typeof name !== 'string' || !/^cordis-sandbox-[a-f0-9]{24}-[a-f0-9]{24}$/.test(name))
      throw new Error();
    const observer = projection.observer(),
      expected = observer.observe(name);
    const observed = projection.read(observer, expected);
    const payload = Object.freeze({
      kind: 'kata-launch-binding' as const,
      formatVersion: 1 as const,
      policyDigest: projection.digest,
      ...observed,
    });
    const proof = Object.freeze({ ...payload, digest: CanonicalJson.digest(payload) });
    return new KataLaunchAttestation(projection, observer, proof.boot.process, proof);
  }
  verify(): void {
    KataSandboxError.require(!this.closed, 'KATA_LAUNCH_CLOSED');
    try {
      const observed = this.projection.read(this.observer, this.expected);
      if (
        observed.boot.digest !== this.proof.boot.digest ||
        this.projection.digest !== this.proof.policyDigest ||
        CanonicalJson.stringify(observed.machine) !== CanonicalJson.stringify(this.proof.machine)
      )
        throw new Error();
    } catch {
      throw new KataSandboxError('KATA_LAUNCH_CHANGED');
    }
  }
  close(): void {
    this.closed = true;
  }
}

export interface SandboxProcessIdentity {
  pid: number;
  startTime: string;
  executableDigest: string;
  commandDigest: string;
}
interface ProcessRow {
  pid: number;
  startTime: string;
  commandDigest: string;
}
export class SandboxProcessObserver {
  constructor(
    private readonly executable: { path: string; sha256: string },
    private readonly ownerUid: number,
  ) {}
  observe(name: string): SandboxProcessIdentity {
    const rows = this.matches(name);
    if (rows.length !== 1) throw new Error('SANDBOX_PROCESS_AMBIGUOUS');
    const row = rows[0]!;
    const executableDigest = this.executableIdentity(row.pid);
    if (this.startTime(row.pid) !== row.startTime) throw new Error('SANDBOX_PROCESS_IDENTITY');
    return { ...row, executableDigest };
  }
  private executableIdentity(pid: number): string {
    const path = '/proc/' + pid;
    if (
      lstatSync(path).uid !== this.ownerUid ||
      readlinkSync(path + '/exe') !== this.executable.path
    )
      throw new Error('SANDBOX_PROCESS_IDENTITY');
    const bytes = readFileSync(path + '/exe');
    const executableDigest = createHash('sha256').update(bytes).digest('hex');
    if (executableDigest !== this.executable.sha256) throw new Error('SANDBOX_PROCESS_IDENTITY');
    return executableDigest;
  }
  capture(name: string): SandboxProcessIdentity | null {
    return this.absent(name) ? null : this.observe(name);
  }
  boot(expected: SandboxProcessIdentity): SandboxBootObservation {
    try {
      const identity = this.bootIdentity(expected);
      const bytes = this.startupCommand(identity);
      const boot = new QemuBootProjection().parse(bytes.toString('utf8').split('\0'));
      const payload = Object.freeze({
        kind: 'kata-boot-observation' as const,
        formatVersion: 1 as const,
        process: identity,
        boot,
      });
      this.startupCommand(identity);
      if (this.startTime(identity.pid) !== identity.startTime) throw new Error();
      return Object.freeze({ ...payload, digest: CanonicalJson.digest(payload) });
    } catch {
      throw new Error('SANDBOX_BOOT_OBSERVATION_UNVERIFIED');
    }
  }
  private bootIdentity(expected: SandboxProcessIdentity): Readonly<SandboxProcessIdentity> {
    if (
      !Number.isSafeInteger(expected.pid) ||
      expected.pid < 1 ||
      !/^[0-9]+$/.test(expected.startTime) ||
      !/^[a-f0-9]{64}$/.test(expected.commandDigest) ||
      !/^[a-f0-9]{64}$/.test(expected.executableDigest)
    )
      throw new Error();
    return Object.freeze({
      pid: expected.pid,
      startTime: expected.startTime,
      executableDigest: expected.executableDigest,
      commandDigest: expected.commandDigest,
    });
  }
  startup(expected: SandboxProcessIdentity): SandboxVmStartupShape {
    try {
      const bytes = this.startupCommand(expected);
      const result = new QemuStartupShape().parse(bytes.toString('utf8').split('\0'));
      if (this.startTime(expected.pid) !== expected.startTime) throw new Error();
      return result;
    } catch {
      throw new Error('SANDBOX_VM_SHAPE_UNVERIFIED');
    }
  }
  private startupCommand(expected: SandboxProcessIdentity): Buffer {
    if (
      this.startTime(expected.pid) !== expected.startTime ||
      this.executableIdentity(expected.pid) !== expected.executableDigest
    )
      throw new Error();
    const bytes = readFileSync('/proc/' + expected.pid + '/cmdline');
    if (
      bytes.length > 1024 * 1024 ||
      createHash('sha256').update(bytes).digest('hex') !== expected.commandDigest
    )
      throw new Error();
    return bytes;
  }
  absent(name: string): boolean {
    return this.matches(name).length === 0;
  }
  async waitGone(
    name: string,
    signal: AbortSignal,
    expected?: SandboxProcessIdentity,
  ): Promise<void> {
    const deadline = Date.now() + 10000;
    while (!this.absent(name) || (expected && !this.ended(expected))) {
      signal.throwIfAborted();
      if (Date.now() >= deadline) throw new Error('SANDBOX_PROCESS_TEARDOWN_UNVERIFIED');
      await delay(25, undefined, { signal });
    }
  }
  private ended(expected: SandboxProcessIdentity): boolean {
    try {
      return this.startTime(expected.pid) !== expected.startTime;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ESRCH') return true;
      throw error;
    }
  }
  private matches(name: string): ProcessRow[] {
    const rows: ProcessRow[] = [];
    for (const entry of readdirSync('/proc')) {
      if (!/^[0-9]+$/.test(entry)) continue;
      const row = this.match(Number(entry), name);
      if (row) rows.push(row);
    }
    return rows;
  }
  private match(pid: number, name: string): ProcessRow | null {
    try {
      const startTime = this.startTime(pid);
      const bytes = readFileSync('/proc/' + pid + '/cmdline');
      if (bytes.length > 1024 * 1024) throw new Error('SANDBOX_PROCESS_COMMAND_LIMIT');
      const args = bytes.toString('utf8').split('\0');
      const position = args.indexOf('-name');
      if (position < 0 || args[position + 1] !== 'sandbox-' + name) return null;
      if (this.startTime(pid) !== startTime) throw new Error('SANDBOX_PROCESS_CHANGED');
      return { pid, startTime, commandDigest: createHash('sha256').update(bytes).digest('hex') };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ESRCH') return null;
      throw error;
    }
  }
  private startTime(pid: number): string {
    const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
    const value = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/)[19];
    if (!value || !/^[0-9]+$/.test(value)) throw new Error('SANDBOX_PROCESS_IDENTITY');
    return value;
  }
}

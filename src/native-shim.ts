import { z } from 'zod';
import { readFileSync, readlinkSync, lstatSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { CanonicalJson } from '@treeseed-cordis/sdk';
import { EffectiveRuntimePolicy } from './runtime-policy.js';
import { KataSandboxError } from './kata-command.js';
import {
  KataLaunchAttestation,
  type KataLaunchProof,
  type SandboxProcessIdentity,
} from './kata-hypervisor.js';

export interface NativeRuntimeProof {
  readonly kind: 'kata-runtime-binding';
  readonly formatVersion: 1;
  readonly policyDigest: string;
  readonly bootDigest: string;
  readonly sandboxName: string;
  readonly namespace: string;
  readonly shim: Readonly<SandboxProcessIdentity>;
  readonly digest: string;
}
/** Pinned argument syntax only, never process observation or authority. */
export class NativeShimProjection {
  private static readonly args = z.array(z.string().min(1).max(4096)).max(8192);
  parse(input: unknown, name: unknown): Readonly<{ sandboxName: string; namespace: string }> {
    try {
      if (typeof name !== 'string' || !/^cordis-sandbox-[a-f0-9]{24}-[a-f0-9]{24}$/.test(name))
        throw new Error();
      const args = this.bounded(input),
        namespace = name.slice(0, -25);
      if (this.one(args, '-id') !== name || this.one(args, '-namespace') !== namespace)
        throw new Error();
      return Object.freeze({ sandboxName: name, namespace });
    } catch {
      throw new KataSandboxError('KATA_SHIM_ARGUMENTS_INVALID');
    }
  }
  private bounded(input: unknown): string[] {
    const args = NativeShimProjection.args.parse(input);
    let size = 0;
    for (const arg of args) {
      if (arg.includes('\0') || /^--|^-(?:id|namespace)=/.test(arg)) throw new Error();
      size += Buffer.byteLength(arg) + 1;
      if (size > 1048576) throw new Error();
    }
    return args;
  }
  private one(args: readonly string[], flag: string): string {
    const values = [];
    for (let index = 1; index < args.length; index++)
      if (args[index] === flag) {
        const value = args[index + 1];
        if (!value || value.startsWith('-')) throw new Error();
        values.push(value);
      }
    if (values.length !== 1) throw new Error();
    return values[0]!;
  }
}
interface NativeProcessRow {
  pid: number;
  parent: number;
  startTime: string;
}
/** Actual Linux reads; expected executable comes only from genuine retained policy. */
class NativeShimObserver {
  private readonly executable: Readonly<{ path: string; sha256: string; size: number }>;
  constructor(
    private readonly policy: EffectiveRuntimePolicy,
    private readonly name: string,
  ) {
    policy.verify();
    const binding = policy.proof.bindings.find(NativeShimObserver.shim);
    const component = policy.proof.components.find(NativeShimObserver.shim);
    if (!binding || !component || policy.proof.installationRoot !== '/') throw new Error();
    this.executable = Object.freeze({
      path: binding.path,
      sha256: component.member.sha256,
      size: component.member.size,
    });
  }
  private static shim(value: { role: string }): boolean {
    return value.role === 'shim';
  }
  read(launch: KataLaunchAttestation): NativeRuntimeProof {
    this.policy.verify();
    launch.verify();
    const observed = this.capture(launch.proof.boot.process);
    const content = {
      kind: 'kata-runtime-binding' as const,
      formatVersion: 1 as const,
      policyDigest: this.policy.proof.digest,
      bootDigest: launch.proof.boot.digest,
      sandboxName: this.name,
      namespace: observed.namespace,
      shim: observed.shim,
    };
    this.policy.verify();
    launch.verify();
    return Object.freeze({ ...content, digest: CanonicalJson.digest(content) });
  }
  private capture(child: SandboxProcessIdentity): Pick<NativeRuntimeProof, 'shim' | 'namespace'> {
    const before = this.row(child.pid);
    if (before.startTime !== child.startTime || before.parent < 2) throw new Error();
    const parent = this.row(before.parent);
    if (BigInt(parent.startTime) > BigInt(before.startTime)) throw new Error();
    const executableDigest = this.binary(parent.pid);
    const command = this.command(parent.pid);
    const selected = new NativeShimProjection().parse(command.args, this.name);
    const shim = Object.freeze({
      pid: parent.pid,
      startTime: parent.startTime,
      commandDigest: command.digest,
      executableDigest,
    });
    this.same(before);
    this.same(parent);
    return { shim, namespace: selected.namespace };
  }
  private row(pid: number): NativeProcessRow {
    if (!Number.isSafeInteger(pid) || pid < 2 || lstatSync('/proc/' + pid).uid !== 0)
      throw new Error();
    const text = readFileSync('/proc/' + pid + '/stat', 'utf8');
    if (text.length > 1048576 || text.lastIndexOf(')') < 1) throw new Error();
    const fields = text
      .slice(text.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    const parent = Number(fields[1]),
      startTime = fields[19];
    if (
      !Number.isSafeInteger(parent) ||
      parent < 1 ||
      !startTime ||
      !/^[0-9]+$/.test(startTime) ||
      ['Z', 'X', 'x'].includes(fields[0]!)
    )
      throw new Error();
    return { pid, parent, startTime };
  }
  private same(expected: NativeProcessRow): void {
    if (CanonicalJson.stringify(this.row(expected.pid)) !== CanonicalJson.stringify(expected))
      throw new Error();
  }
  private binary(pid: number): string {
    const path = '/proc/' + pid + '/exe';
    if (readlinkSync(path) !== this.executable.path) throw new Error();
    const actual = statSync(path),
      selected = lstatSync(this.executable.path);
    if (
      !actual.isFile() ||
      !selected.isFile() ||
      actual.dev !== selected.dev ||
      actual.ino !== selected.ino ||
      actual.size !== this.executable.size
    )
      throw new Error();
    const bytes = readFileSync(path);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== this.executable.size || digest !== this.executable.sha256)
      throw new Error();
    return digest;
  }
  private command(pid: number): { args: string[]; digest: string } {
    const bytes = readFileSync('/proc/' + pid + '/cmdline');
    if (bytes.length < 2 || bytes.length > 1048576 || bytes[bytes.length - 1] !== 0)
      throw new Error();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return {
      args: text.slice(0, -1).split('\0'),
      digest: createHash('sha256').update(bytes).digest('hex'),
    };
  }
}
/** Coherent borrowed policy/process admission, never a provider registry or VM lifecycle owner. */
export class NativeRuntimeAttestation {
  private closed = false;
  private constructor(
    private readonly launch: KataLaunchAttestation,
    private readonly observer: NativeShimObserver,
    readonly binding: NativeRuntimeProof,
  ) {}
  get proof(): KataLaunchProof {
    return this.launch.proof;
  }
  static async open(
    policy: EffectiveRuntimePolicy,
    name: string,
    signal: AbortSignal,
  ): Promise<NativeRuntimeAttestation> {
    let admission: NativeRuntimeAttestation | null = null;
    try {
      if (!(signal instanceof AbortSignal)) throw new Error();
      signal.throwIfAborted();
      admission = await this.capture(policy, name, signal);
      await setImmediate();
      signal.throwIfAborted();
      admission.verify();
      return admission;
    } catch {
      admission?.close();
      const cancelled = signal instanceof AbortSignal && signal.aborted;
      throw new KataSandboxError(cancelled ? 'KATA_CANCELLED' : 'KATA_RUNTIME_INVALID');
    }
  }
  private static async capture(
    policy: EffectiveRuntimePolicy,
    name: string,
    signal: AbortSignal,
  ): Promise<NativeRuntimeAttestation> {
    const launch = await KataLaunchAttestation.open(policy, name, signal);
    try {
      const observer = new NativeShimObserver(policy, name);
      return new NativeRuntimeAttestation(launch, observer, observer.read(launch));
    } catch (error) {
      launch.close();
      throw error;
    }
  }
  verify(): void {
    KataSandboxError.require(!this.closed, 'KATA_RUNTIME_CLOSED');
    try {
      if (this.observer.read(this.launch).digest !== this.binding.digest) throw new Error();
    } catch {
      throw new KataSandboxError('KATA_RUNTIME_CHANGED');
    }
  }
  close(): void {
    this.closed = true;
    this.launch.close();
  }
}

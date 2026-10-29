import { readdirSync, readFileSync, readlinkSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { QemuStartupShape, type SandboxVmStartupShape } from './kata-vm-shape.js';
import { resolve } from 'node:path';
import { CanonicalJson } from '@treeseed-cordis/sdk';
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

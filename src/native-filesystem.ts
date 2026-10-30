import { z } from 'zod';
import { readFileSync, readlinkSync, readdirSync, lstatSync, statSync, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { CanonicalJson } from '@treeseed-cordis/sdk';
import { EffectiveRuntimePolicy } from './runtime-policy.js';
import { KataSandboxError } from './kata-command.js';
import type { KataLaunchProof, SandboxProcessIdentity } from './kata-hypervisor.js';
import { NativeRuntimeAttestation, type NativeRuntimeProof } from './native-shim.js';

interface FilesystemSelection {
  readonly socketPath: string;
  readonly sharedDirectory: string;
}
interface FilesystemSocket {
  readonly inode: string;
  readonly pathDigest: string;
  readonly state: 'connected';
}
export interface NativeFilesystemProof {
  readonly kind: 'kata-filesystem-binding';
  readonly formatVersion: 1;
  readonly policyDigest: string;
  readonly runtimeDigest: string;
  readonly bootDigest: string;
  readonly daemon: Readonly<SandboxProcessIdentity>;
  readonly server: Readonly<SandboxProcessIdentity>;
  readonly socket: FilesystemSocket;
  readonly shared: Readonly<{ device: number; inode: number }>;
  readonly digest: string;
}
/** Pure pinned syntax/state projection; supplied strings never establish process authority. */
export class NativeFilesystemProjection {
  private static readonly args = z.array(z.string().min(1).max(4096)).max(8192);
  parse(qemu: unknown, daemon: unknown, name: unknown): Readonly<FilesystemSelection> {
    try {
      if (typeof name !== 'string' || !/^cordis-sandbox-[a-f0-9]{24}-[a-f0-9]{24}$/.test(name))
        throw new Error();
      const selected = Object.freeze({
        socketPath: '/run/kata/' + name + '/root/virtiofsd.sock',
        sharedDirectory: '/run/kata-containers/shared/sandboxes/' + name + '/ro',
      });
      this.qemu(this.arguments(qemu), selected.socketPath);
      this.daemon(this.arguments(daemon), selected);
      return selected;
    } catch (error) {
      FilesystemDiagnostic.trace(error);
      throw new KataSandboxError('KATA_FILESYSTEM_ARGUMENTS_INVALID');
    }
  }
  private arguments(input: unknown): string[] {
    const args = NativeFilesystemProjection.args.parse(input);
    let bytes = 0;
    for (const arg of args) {
      bytes += Buffer.byteLength(arg) + 1;
      if (arg.includes('\0') || bytes > 1048576) throw new Error();
    }
    return args;
  }
  private qemu(args: readonly string[], path: string): void {
    for (const arg of args)
      if (/^--|^-(?:chardev|device)=/.test(arg) || ['-fsdev', '-virtfs'].includes(arg))
        throw new Error();
    const characters = [];
    for (const value of this.many(args, '-chardev')) {
      const fields = this.fields(value);
      if (fields.get('id') === 'virtiofsd-chardev') characters.push(value);
    }
    if (characters.length !== 1) throw new Error();
    const expected = 'socket,id=virtiofsd-chardev,path=' + path;
    if (characters[0] !== expected) throw new Error();
    this.device(args);
  }
  private device(args: readonly string[]): void {
    const devices = [];
    for (const value of this.many(args, '-device')) {
      if (value.startsWith('virtio-9p')) throw new Error();
      if (value.startsWith('vhost-user-fs')) devices.push(value);
    }
    const expected = 'vhost-user-fs-pci,chardev=virtiofsd-chardev,tag=kataShared,queue-size=1024';
    if (devices.length !== 1 || devices[0] !== expected) throw new Error();
  }
  private fields(value: string): Map<string, string> {
    const result = new Map<string, string>();
    for (const field of value.split(',').slice(1)) {
      const [key, entry, extra] = field.split('=');
      if (!key || !entry || extra !== undefined || result.has(key)) throw new Error();
      result.set(key, entry);
    }
    return result;
  }
  private many(args: readonly string[], flag: string): string[] {
    const values = [];
    for (let index = 1; index < args.length; index++)
      if (args[index] === flag) {
        const value = args[index + 1];
        if (!value || value.startsWith('-')) throw new Error();
        values.push(value);
      }
    return values;
  }
  private daemon(args: readonly string[], selected: FilesystemSelection): void {
    const expected = [
      '--socket-path',
      selected.socketPath,
      '--shared-dir',
      selected.sharedDirectory,
      '--cache',
      'auto',
      '--thread-pool-size=1',
      '-o',
      'announce_submounts',
    ];
    if (CanonicalJson.stringify(args.slice(1)) !== CanonicalJson.stringify(expected))
      throw new Error();
  }
  connection(table: unknown, targets: unknown, path: unknown): FilesystemSocket {
    try {
      if (
        typeof path !== 'string' ||
        !/^\/run\/kata\/cordis-sandbox-[a-f0-9]{24}-[a-f0-9]{24}\/root\/virtiofsd\.sock$/.test(path)
      )
        throw new Error();
      const rows = this.rows(table, path);
      const descriptors = z.array(z.string().max(4096)).max(32768).parse(targets);
      if (rows.length !== 1 || !descriptors.includes('socket:[' + rows[0] + ']')) throw new Error();
      return Object.freeze({
        inode: rows[0]!,
        pathDigest: createHash('sha256').update(path).digest('hex'),
        state: 'connected' as const,
      });
    } catch (error) {
      FilesystemDiagnostic.trace(error);
      throw new KataSandboxError('KATA_FILESYSTEM_ARGUMENTS_INVALID');
    }
  }
  private rows(input: unknown, path: string): string[] {
    const rows = [];
    for (const line of this.lines(input)) {
      const fields = line.trim().split(/\s+/);
      if (fields[7] !== path || fields[5] !== '03') continue;
      if (
        fields.length !== 8 ||
        fields[2] !== '00000000' ||
        fields[3] !== '00000000' ||
        fields[4] !== '0001' ||
        !/^[1-9][0-9]*$/.test(fields[6]!)
      )
        throw new Error();
      rows.push(fields[6]!);
    }
    return rows;
  }
  private lines(input: unknown): string[] {
    const text = z.string().min(1).max(1048576).parse(input);
    if (text.includes('\0')) throw new Error();
    const lines = text.trim().split('\n');
    if (
      lines.length > 32768 ||
      lines.shift()!.trim().replace(/\s+/g, ' ') !==
        'Num RefCount Protocol Flags Type St Inode Path'
    )
      throw new Error();
    return lines;
  }
}
interface ProcessRow {
  readonly pid: number;
  readonly parent: number;
  readonly startTime: string;
}
interface FilesystemProcess {
  readonly row: ProcessRow;
  readonly identity: Readonly<SandboxProcessIdentity>;
  readonly args: readonly string[];
}
/** Actual selected executable and stable direct ancestry, including namespace-mode serving fork. */
class NativeFilesystemProcesses {
  private readonly executable: Readonly<{ path: string; sha256: string; size: number }>;
  constructor(policy: EffectiveRuntimePolicy) {
    policy.verify();
    const binding = policy.proof.bindings.find(NativeFilesystemProcesses.virtiofs);
    const component = policy.proof.components.find(NativeFilesystemProcesses.virtiofs);
    if (!binding || !component) throw new Error();
    this.executable = Object.freeze({
      path: binding.path,
      sha256: component.member.sha256,
      size: component.member.size,
    });
  }
  private static virtiofs(value: { role: string }): boolean {
    return value.role === 'virtiofs';
  }
  family(shim: Readonly<SandboxProcessIdentity>): {
    daemon: FilesystemProcess;
    server: FilesystemProcess;
  } {
    const daemon = this.one(shim.pid);
    const server = this.one(daemon.row.pid);
    this.parent(daemon.row, shim);
    this.parent(server.row, daemon.identity);
    return { daemon, server };
  }
  private parent(child: ProcessRow, parent: Readonly<SandboxProcessIdentity>): void {
    if (child.parent !== parent.pid || BigInt(child.startTime) < BigInt(parent.startTime))
      throw new Error();
  }
  private one(parent: number): FilesystemProcess {
    const selected = [];
    for (const pid of this.children(parent)) {
      try {
        if (readlinkSync('/proc/' + pid + '/exe') === this.executable.path)
          selected.push(this.observe(pid));
      } catch (error) {
        if (!this.ended(error)) throw error;
      }
    }
    if (selected.length !== 1) throw new Error();
    return selected[0]!;
  }
  private children(pid: number): Set<number> {
    const threads = readdirSync('/proc/' + pid + '/task');
    if (threads.length > 4096) throw new Error();
    const result = new Set<number>();
    for (const thread of threads)
      if (/^[0-9]+$/.test(thread))
        for (const child of this.threadChildren(pid, thread)) result.add(child);
    if (result.size > 8192) throw new Error();
    return result;
  }
  private threadChildren(pid: number, thread: string): number[] {
    try {
      const text = readFileSync('/proc/' + pid + '/task/' + thread + '/children', 'utf8').trim();
      if (text.length > 1048576) throw new Error();
      if (!text) return [];
      const result = [];
      for (const value of text.split(/\s+/)) {
        const child = Number(value);
        if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(child) || child < 2)
          throw new Error();
        result.push(child);
      }
      return result;
    } catch (error) {
      if (this.ended(error)) return [];
      throw error;
    }
  }
  private ended(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === 'ENOENT' || code === 'ESRCH';
  }
  private observe(pid: number): FilesystemProcess {
    const row = this.row(pid),
      executableDigest = this.binary(pid);
    const bytes = readFileSync('/proc/' + pid + '/cmdline');
    if (bytes.length < 2 || bytes.length > 1048576 || bytes[bytes.length - 1] !== 0)
      throw new Error();
    const args = Object.freeze(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes).slice(0, -1).split('\0'),
    );
    const identity = Object.freeze({
      pid,
      startTime: row.startTime,
      executableDigest,
      commandDigest: createHash('sha256').update(bytes).digest('hex'),
    });
    if (CanonicalJson.stringify(this.row(pid)) !== CanonicalJson.stringify(row)) throw new Error();
    return Object.freeze({ row: Object.freeze(row), identity, args });
  }
  private row(pid: number): ProcessRow {
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
    const bytes = readFileSync(path),
      digest = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== this.executable.size || digest !== this.executable.sha256)
      throw new Error();
    return digest;
  }
  same(process: FilesystemProcess): void {
    if (CanonicalJson.stringify(this.observe(process.row.pid)) !== CanonicalJson.stringify(process))
      throw new Error();
  }
}
/** Process-held connected socket and pivoted shared root, never a path-only readiness assertion. */
class NativeFilesystemSocket {
  read(
    server: FilesystemProcess,
    qemu: number,
    selected: FilesystemSelection,
  ): Pick<NativeFilesystemProof, 'socket' | 'shared'> {
    const table = readFileSync('/proc/' + qemu + '/net/unix', 'utf8');
    const targets = this.targets(server.row.pid);
    const socket = new NativeFilesystemProjection().connection(table, targets, selected.socketPath);
    const shared = this.shared(server.row.pid, selected.sharedDirectory);
    return { socket, shared };
  }
  private targets(pid: number): string[] {
    const path = '/proc/' + pid + '/fd',
      entries = readdirSync(path);
    if (entries.length > 32768) throw new Error();
    const targets = [];
    for (const entry of entries) {
      if (!/^[0-9]+$/.test(entry)) throw new Error();
      try {
        targets.push(readlinkSync(path + '/' + entry));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return targets;
  }
  private shared(pid: number, path: string): NativeFilesystemProof['shared'] {
    const selected = lstatSync(path),
      actual = statSync('/proc/' + pid + '/root');
    FilesystemDiagnostic.root(selected, actual);
    if (
      !selected.isDirectory() ||
      selected.isSymbolicLink() ||
      selected.uid !== 0 ||
      (selected.mode & 0o022) !== 0 ||
      !actual.isDirectory() ||
      actual.dev !== selected.dev ||
      actual.ino !== selected.ino
    )
      throw new Error();
    return Object.freeze({ device: actual.dev, inode: actual.ino });
  }
}
class NativeFilesystemObserver {
  private readonly processes: NativeFilesystemProcesses;
  constructor(
    private readonly policy: EffectiveRuntimePolicy,
    private readonly name: string,
  ) {
    policy.verify();
    this.processes = new NativeFilesystemProcesses(policy);
  }
  read(runtime: NativeRuntimeAttestation): NativeFilesystemProof {
    this.policy.verify();
    runtime.verify();
    const family = this.processes.family(runtime.binding.shim);
    const qemu = this.qemu(runtime.proof);
    const selected = new NativeFilesystemProjection().parse(qemu, family.daemon.args, this.name);
    new NativeFilesystemProjection().parse(qemu, family.server.args, this.name);
    FilesystemDiagnostic.sockets(runtime, family.server, selected.socketPath);
    const state = new NativeFilesystemSocket().read(
      family.server,
      runtime.proof.boot.process.pid,
      selected,
    );
    this.processes.same(family.daemon);
    this.processes.same(family.server);
    this.policy.verify();
    runtime.verify();
    return this.proof(runtime, family, state);
  }
  private qemu(proof: KataLaunchProof): string[] {
    const bytes = readFileSync('/proc/' + proof.boot.process.pid + '/cmdline');
    if (
      bytes.length > 1048576 ||
      bytes[bytes.length - 1] !== 0 ||
      createHash('sha256').update(bytes).digest('hex') !== proof.boot.process.commandDigest
    )
      throw new Error();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).slice(0, -1).split('\0');
  }
  private proof(
    runtime: NativeRuntimeAttestation,
    family: { daemon: FilesystemProcess; server: FilesystemProcess },
    state: Pick<NativeFilesystemProof, 'socket' | 'shared'>,
  ): NativeFilesystemProof {
    const content = {
      kind: 'kata-filesystem-binding' as const,
      formatVersion: 1 as const,
      policyDigest: this.policy.proof.digest,
      runtimeDigest: runtime.binding.digest,
      bootDigest: runtime.proof.boot.digest,
      daemon: family.daemon.identity,
      server: family.server.identity,
      ...state,
    };
    return Object.freeze({ ...content, digest: CanonicalJson.digest(content) });
  }
}
/** One coherent borrowed runtime/filesystem admission, not a replacement lifecycle owner. */
export class NativeFilesystemAttestation {
  private closed = false;
  private constructor(
    private readonly admission: NativeRuntimeAttestation,
    private readonly observer: NativeFilesystemObserver,
    readonly binding: NativeFilesystemProof,
  ) {}
  get proof(): KataLaunchProof {
    return this.admission.proof;
  }
  get runtime(): NativeRuntimeProof {
    return this.admission.binding;
  }
  static async open(
    policy: EffectiveRuntimePolicy,
    name: string,
    signal: AbortSignal,
  ): Promise<NativeFilesystemAttestation> {
    let admission: NativeFilesystemAttestation | null = null;
    try {
      if (!(signal instanceof AbortSignal)) throw new Error();
      signal.throwIfAborted();
      admission = await this.capture(policy, name, signal);
      await setImmediate();
      signal.throwIfAborted();
      admission.verify();
      return admission;
    } catch (error) {
      FilesystemDiagnostic.trace(error);
      admission?.close();
      const cancelled = signal instanceof AbortSignal && signal.aborted;
      throw new KataSandboxError(cancelled ? 'KATA_CANCELLED' : 'KATA_FILESYSTEM_INVALID');
    }
  }
  private static async capture(
    policy: EffectiveRuntimePolicy,
    name: string,
    signal: AbortSignal,
  ): Promise<NativeFilesystemAttestation> {
    const runtime = await NativeRuntimeAttestation.open(policy, name, signal);
    try {
      const observer = new NativeFilesystemObserver(policy, name);
      return new NativeFilesystemAttestation(runtime, observer, observer.read(runtime));
    } catch (error) {
      runtime.close();
      throw error;
    }
  }
  verify(): void {
    KataSandboxError.require(!this.closed, 'KATA_FILESYSTEM_CLOSED');
    try {
      if (this.observer.read(this.admission).digest !== this.binding.digest) throw new Error();
    } catch {
      throw new KataSandboxError('KATA_FILESYSTEM_CHANGED');
    }
  }
  close(): void {
    this.closed = true;
    this.admission.close();
  }
}
/** Temporary bounded hosted evidence; remove before final source/artifact qualification. */
class FilesystemDiagnostic {
  static root(selected: Stats, actual: Stats): void {
    const rows = [];
    for (const value of [selected, actual])
      rows.push({
        directory: value.isDirectory(),
        uid: value.uid,
        mode: value.mode & 0o7777,
        device: value.dev,
        inode: value.ino,
      });
    process.stderr.write('DIAGNOSTIC_FILESYSTEM_ROOT ' + JSON.stringify(rows) + '\n');
  }
  static trace(error: unknown): void {
    if (!(error instanceof Error)) return;
    let count = 0;
    for (const line of error.stack?.split('\n') ?? []) {
      if (!line.includes('/native-filesystem.js:')) continue;
      const match = /^\s*at ([A-Za-z0-9_.]+).*:(\d+):\d+\)?$/.exec(line);
      if (!match || ++count > 4) continue;
      process.stderr.write(
        'DIAGNOSTIC_FILESYSTEM_FRAME ' +
          JSON.stringify({ symbol: match[1], line: Number(match[2]) }) +
          '\n',
      );
    }
  }
  static sockets(runtime: NativeRuntimeAttestation, server: FilesystemProcess, path: string): void {
    const roles = {
      qemu: runtime.proof.boot.process.pid,
      shim: runtime.binding.shim.pid,
      server: server.row.pid,
    };
    const targets = [];
    for (const name of readdirSync('/proc/' + server.row.pid + '/fd')) {
      const value = readlinkSync('/proc/' + server.row.pid + '/fd/' + name);
      if (/^socket:\[[0-9]+\]$/.test(value) && targets.length < 16) targets.push(value);
    }
    const rows: Record<string, string[][]> = {};
    for (const [role, pid] of Object.entries(roles)) rows[role] = this.rows(pid, path);
    process.stderr.write(
      'DIAGNOSTIC_FILESYSTEM_SOCKETS ' + JSON.stringify({ rows, targets }) + '\n',
    );
  }
  private static rows(pid: number, path: string): string[][] {
    const result = [];
    for (const line of readFileSync('/proc/' + pid + '/net/unix', 'utf8').split('\n')) {
      const fields = line.trim().split(/\s+/);
      if (fields[7] !== path || result.length >= 4) continue;
      const selected = fields.slice(2, 7);
      for (const value of selected) if (!/^[a-f0-9]+$/.test(value)) throw new Error();
      result.push(selected);
    }
    return result;
  }
}

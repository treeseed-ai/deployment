import { readdirSync, readFileSync, readlinkSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

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
    const path = '/proc/' + row.pid;
    if (
      lstatSync(path).uid !== this.ownerUid ||
      readlinkSync(path + '/exe') !== this.executable.path
    )
      throw new Error('SANDBOX_PROCESS_IDENTITY');
    const bytes = readFileSync(path + '/exe');
    const executableDigest = createHash('sha256').update(bytes).digest('hex');
    if (executableDigest !== this.executable.sha256 || this.startTime(row.pid) !== row.startTime)
      throw new Error('SANDBOX_PROCESS_IDENTITY');
    return { ...row, executableDigest };
  }
  capture(name: string): SandboxProcessIdentity | null {
    return this.absent(name) ? null : this.observe(name);
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

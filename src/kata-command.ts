import { spawn, type ChildProcess } from 'node:child_process';
export interface KataCommandOptions {
  stdin?: Buffer;
  deadlineMs?: number;
  deadline?: number;
  outputLimitBytes?: number;
}
export class KataSandboxError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'KataSandboxError';
  }
  static require(value: unknown, code: string): asserts value {
    if (!value) throw new KataSandboxError(code);
  }
}

export class KataCommand {
  private child: ChildProcess | null = null;
  private readonly chunks: Buffer[] = [];
  private count = 0;
  private deadline = 0;
  private failure: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private accept: ((bytes: Buffer) => void) | null = null;
  private reject: ((error: Error) => void) | null = null;
  private readonly cancellation: () => void;
  constructor(
    private readonly executable: string,
    private readonly args: string[],
    private readonly signal: AbortSignal,
    private readonly options: KataCommandOptions = {},
  ) {
    this.cancellation = this.cancel.bind(this);
  }
  run(): Promise<Buffer> {
    return new Promise(this.start.bind(this));
  }
  private start(accept: (bytes: Buffer) => void, reject: (error: Error) => void): void {
    this.accept = accept;
    this.reject = reject;
    this.deadline = Math.min(
      performance.now() + (this.options.deadlineMs ?? 120000),
      this.options.deadline ?? Infinity,
    );
    if (this.signal.aborted || performance.now() >= this.deadline) return this.finish(null);
    this.child = spawn(this.executable, this.args, {
      stdio: [this.options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
    });
    this.input();
    this.child.once('error', this.failed.bind(this));
    this.child.once('close', this.finish.bind(this));
    this.child.stdout!.on('data', this.output.bind(this));
    this.child.stderr!.on('data', this.discard.bind(this));
    this.signal.addEventListener('abort', this.cancellation, { once: true });
    this.timer = setTimeout(this.timeout.bind(this), this.deadline - performance.now());
  }
  get outputBytes(): number {
    return this.count;
  }
  private input(): void {
    if (!this.options.stdin) return;
    this.child!.stdin!.on('error', this.failed.bind(this));
    this.child!.stdin!.end(this.options.stdin);
  }
  private output(bytes: Buffer): void {
    if (this.limit(bytes.length)) this.chunks.push(bytes);
  }
  private discard(bytes: Buffer): void {
    this.limit(bytes.length);
  }
  private limit(size: number): boolean {
    this.count += size;
    if (this.count <= (this.options.outputLimitBytes ?? 1024 * 1024)) return true;
    this.failure = 'KATA_OUTPUT_LIMIT';
    this.terminate();
    return false;
  }
  private failed(): void {
    this.failure = 'KATA_COMMAND_FAILED';
  }
  private cancel(): void {
    this.failure = 'KATA_CANCELLED';
    this.terminate();
  }
  private timeout(): void {
    this.failure = 'KATA_COMMAND_TIMEOUT';
    this.terminate();
  }
  private terminate(): void {
    this.child?.kill('SIGTERM');
    if (!this.killTimer) this.killTimer = setTimeout(this.kill.bind(this), 1000);
  }
  private kill(): void {
    this.child?.kill('SIGKILL');
  }
  private finish(code: number | null): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.killTimer) clearTimeout(this.killTimer);
    this.signal.removeEventListener('abort', this.cancellation);
    if (this.deadline > 0 && performance.now() >= this.deadline)
      this.failure = 'KATA_COMMAND_TIMEOUT';
    if (this.signal.aborted) this.failure = 'KATA_CANCELLED';
    if (this.failure || code !== 0)
      this.reject!(new KataSandboxError(this.failure ?? 'KATA_COMMAND_FAILED'));
    else this.accept!(Buffer.concat(this.chunks));
  }
}

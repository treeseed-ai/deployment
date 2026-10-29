import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  CapacitySchemas,
  CapacityChannelSchemas,
  CapacityChannelBinding,
  CanonicalJson,
  type CapacityReadiness,
  type CapacityProcessGeneration,
  type CapacityChannelRequest,
} from '@treeseed-cordis/sdk';
import { StrictJson } from './filesystem.js';
import { KataSandboxError } from './kata-command.js';
interface ReadinessWait {
  request: CapacityChannelRequest;
  deadline: number;
  signal: AbortSignal;
  accept: (value: CapacityReadiness) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
/** Physical process I/O only; Agent owns its root, native providers and admission kernel. */
export class KataRunnerSession {
  private buffered = Buffer.alloc(0);
  private generation: CapacityProcessGeneration | null = null;
  private pending: ReadinessWait | null = null;
  private failure: string | null = null;
  private ended = false;
  private closing: Promise<void> | null = null;
  private resolveExit!: (code: number | null) => void;
  private readonly exited = new Promise<number | null>(this.wait.bind(this));
  private readonly cancellation = this.cancel.bind(this);
  private readonly scope;
  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    scope: unknown,
  ) {
    this.scope = CapacitySchemas.scope.parse(scope);
    child.stdout.on('data', this.output.bind(this));
    child.stderr.on('data', this.stderr.bind(this));
    child.stdin.on('error', this.failed.bind(this));
    child.once('error', this.failed.bind(this));
    child.once('close', this.closed.bind(this));
  }
  private wait(resolve: (code: number | null) => void): void {
    this.resolveExit = resolve;
  }
  private closed(code: number | null): void {
    this.ended = true;
    this.resolveExit(code);
    if (this.pending || !this.closing) this.fail('KATA_RUNNER_EXITED');
  }
  private failed(): void {
    this.fail('KATA_RUNNER_FAILED');
  }
  private stderr(): void {
    this.fail('KATA_RUNNER_OUTPUT_INVALID');
  }
  private cancel(): void {
    this.fail('KATA_RUNNER_CANCELLED');
  }
  private timeout(): void {
    this.fail('KATA_RUNNER_TIMEOUT');
  }
  private fail(code: string): void {
    this.failure ??= code;
    const pending = this.pending;
    this.settled();
    pending?.reject(new KataSandboxError(this.failure));
  }
  private settled(): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.signal.removeEventListener('abort', this.cancellation);
  }
  async readiness(signal: AbortSignal): Promise<CapacityReadiness> {
    KataSandboxError.require(
      !this.failure && !this.ended && !this.closing && !this.pending,
      'KATA_RUNNER_UNAVAILABLE',
    );
    KataSandboxError.require(!signal.aborted, 'KATA_RUNNER_CANCELLED');
    const result = await new Promise<CapacityReadiness>(
      this.begin.bind(this, this.readyRequest(), signal),
    );
    if (signal.aborted) this.fail('KATA_RUNNER_CANCELLED');
    KataSandboxError.require(
      !this.failure && !this.ended && !this.closing,
      'KATA_RUNNER_UNAVAILABLE',
    );
    return result;
  }
  private readyRequest(): CapacityChannelRequest {
    return CapacityChannelSchemas.request.parse({
      schemaVersion: 'treeseed.capacity-channel/v1',
      requestId: 'ready.' + randomUUID(),
      scope: this.scope,
      role: 'runner',
      operation: 'ready',
      expectedGeneration: this.generation,
      parameters: {},
    });
  }
  private begin(
    request: CapacityChannelRequest,
    signal: AbortSignal,
    accept: (value: CapacityReadiness) => void,
    reject: (error: Error) => void,
  ): void {
    this.pending = {
      request,
      deadline: performance.now() + 10000,
      signal,
      accept,
      reject,
      timer: setTimeout(this.timeout.bind(this), 10000),
    };
    signal.addEventListener('abort', this.cancellation, { once: true });
    if (signal.aborted) return this.cancel();
    try {
      this.child.stdin.write(CanonicalJson.stringify(request) + '\n');
    } catch {
      this.failed();
    }
  }
  private output(bytes: Buffer): void {
    if (this.failure) return;
    if (bytes.length > 65536 - this.buffered.length) return this.fail('KATA_RUNNER_OUTPUT_INVALID');
    this.buffered = Buffer.concat([this.buffered, bytes]);
    try {
      if (this.buffered.includes(10)) this.frame();
    } catch {
      this.fail('KATA_RUNNER_RESPONSE_INVALID');
    }
  }
  private frame(): void {
    const result = this.response();
    this.buffered = Buffer.alloc(0);
    this.generation = structuredClone(result.generation);
    const accept = this.pending!.accept;
    this.settled();
    accept(result);
  }
  private response(): CapacityReadiness {
    const end = this.buffered.indexOf(10);
    KataSandboxError.require(
      end > 0 &&
        end === this.buffered.length - 1 &&
        this.pending &&
        performance.now() < this.pending.deadline,
      'KATA_RUNNER_RESPONSE_INVALID',
    );
    const response = CapacityChannelBinding.assertResponse(
      StrictJson.parse(this.buffered.subarray(0, end)),
      this.pending.request,
    );
    KataSandboxError.require(
      response.success && response.role === 'runner' && response.operation === 'ready',
      'KATA_RUNNER_RESPONSE_INVALID',
    );
    const result = response.result;
    KataSandboxError.require(result.ready && result.blockers.length === 0, 'KATA_RUNNER_UNREADY');
    return result;
  }
  close(): Promise<void> {
    if (!this.closing) this.closing = new Promise(this.drain.bind(this));
    return this.closing;
  }
  private drain(accept: () => void, reject: (error: Error) => void): void {
    if (this.pending) this.fail('KATA_RUNNER_CANCELLED');
    const timer = setTimeout(this.drainTimeout.bind(this, reject), 5000);
    void this.exited.then(this.drained.bind(this, timer, performance.now() + 5000, accept, reject));
    this.child.stdin.end();
  }
  private drainTimeout(reject: (error: Error) => void): void {
    this.failure ??= 'KATA_RUNNER_CLEANUP_FAILED';
    reject(new KataSandboxError('KATA_RUNNER_CLEANUP_FAILED'));
  }
  private drained(
    timer: ReturnType<typeof setTimeout>,
    deadline: number,
    accept: () => void,
    reject: (error: Error) => void,
    code: number | null,
  ): void {
    clearTimeout(timer);
    if (this.failure || code !== 0 || this.buffered.length || performance.now() >= deadline)
      return reject(new KataSandboxError('KATA_RUNNER_CLEANUP_FAILED'));
    accept();
  }
}

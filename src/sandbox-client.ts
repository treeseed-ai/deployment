import type { z } from 'zod';
import { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  CanonicalJson,
  SandboxControlSchemas,
  SandboxControlBinding,
  SandboxControlError,
  type SandboxControlRequest,
  type SandboxControlResponse,
  type SandboxControlClient,
  type SandboxControlCode,
  type SandboxAvailability,
  type SandboxEvidence,
  type SandboxAssignment,
  type SandboxPhaseReceipt,
  type SandboxDestructionReceipt,
} from '@treeseed-cordis/sdk';
import { SafeDirectory, StrictJson } from './filesystem.js';
import {
  ControlGuard,
  ControlSchemas,
  ControlAuthority,
  ControlSocketReference,
  type ControlAuthorityRecord,
} from './sandbox-io.js';
class ControlExchange {
  private readonly target: ControlSocketReference;
  private readonly socket = new Socket();
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private done = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private accept: ((response: SandboxControlResponse) => void) | null = null;
  private reject: ((error: Error) => void) | null = null;
  private readonly cancellation: () => void;
  constructor(
    private readonly directory: SafeDirectory,
    private readonly request: SandboxControlRequest,
    private readonly authority: ControlAuthority,
    private readonly record: ControlAuthorityRecord,
    private readonly signal: AbortSignal,
    private readonly timeoutMs: number,
  ) {
    this.target = new ControlSocketReference(directory);
    this.cancellation = this.cancel.bind(this);
  }
  run(): Promise<SandboxControlResponse> {
    return new Promise(this.start.bind(this));
  }
  private start(
    accept: (response: SandboxControlResponse) => void,
    reject: (error: Error) => void,
  ): void {
    this.accept = accept;
    this.reject = reject;
    if (this.signal.aborted) return this.cancel();
    this.timer = setTimeout(
      this.failed.bind(this),
      Math.min(this.timeoutMs, this.record.grant.expiresAtEpochMs - Date.now()),
    );
    this.signal.addEventListener('abort', this.cancellation, { once: true });
    this.socket.once('error', this.failed.bind(this));
    this.socket.on('data', this.data.bind(this));
    this.socket.once('end', this.end.bind(this));
    this.socket.once('close', this.closed.bind(this));
    this.socket.connect(this.target.path, this.connected.bind(this));
  }
  private connected(): void {
    try {
      this.target.verify();
      this.authority.verify(this.record);
      SandboxControlBinding.assertRequest(this.request, this.record.grant, Date.now());
      this.socket.write(
        CanonicalJson.stringify({ credential: this.record.credential, request: this.request }) +
          '\n',
      );
    } catch (error) {
      this.fail(ControlGuard.failure(error));
    }
  }
  private data(bytes: Buffer): void {
    if (this.done) return;
    this.bytes += bytes.length;
    if (this.bytes > 65536) return this.failed();
    this.chunks.push(bytes);
  }
  private end(): void {
    if (this.done) return;
    try {
      const bytes = Buffer.concat(this.chunks);
      if (bytes.length === 0) return this.failed();
      ControlGuard.require(
        bytes.length > 0 && bytes.indexOf(10) === bytes.length - 1,
        'SANDBOX_RESPONSE_MISMATCH',
      );
      const response = SandboxControlBinding.assertResponse(
        StrictJson.parse(bytes.subarray(0, -1)),
        this.request,
      );
      this.accepted(response);
    } catch (error) {
      this.fail(ControlGuard.failure(error));
    }
  }
  private accepted(response: SandboxControlResponse): void {
    this.validate();
    if (!this.finish()) this.reject!(new SandboxControlError('SANDBOX_REPAIR_REQUIRED'));
    else this.accept!(response);
  }
  private validate(): void {
    ControlGuard.require(!this.signal.aborted, 'SANDBOX_CANCELLED');
    this.target.verify();
    this.authority.verify(this.record);
    SandboxControlBinding.assertRequest(this.request, this.record.grant, Date.now());
  }
  private closed(): void {
    if (!this.done) this.failed();
  }
  private failed(): void {
    this.fail('SANDBOX_PROVIDER_UNAVAILABLE');
  }
  private cancel(): void {
    this.fail('SANDBOX_CANCELLED');
  }
  private fail(code: SandboxControlCode): void {
    if (this.done) return;
    const closed = this.finish();
    this.reject!(new SandboxControlError(closed ? code : 'SANDBOX_REPAIR_REQUIRED'));
  }
  private finish(): boolean {
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    this.signal.removeEventListener('abort', this.cancellation);
    this.socket.destroy();
    return this.target.close();
  }
}

export class SandboxSocketClient implements SandboxControlClient {
  private readonly configuration: z.infer<typeof ControlSchemas.client>;
  constructor(input: unknown) {
    this.configuration = ControlSchemas.parse(ControlSchemas.client, input);
  }
  private async request(
    operation: SandboxControlRequest['operation'],
    parameters: object,
    signal: AbortSignal,
  ): Promise<Extract<SandboxControlResponse, { success: true }>> {
    const config = this.configuration;
    const authority = new ControlAuthority(config.authorityFile, config.scope);
    const record = authority.read();
    const request = SandboxControlBinding.assertRequest(
      {
        schemaVersion: 'treeseed.sandbox-control/v1',
        requestId: randomUUID(),
        scope: config.scope,
        operation,
        parameters,
      },
      record.grant,
      Date.now(),
    );
    const response = await this.exchange(request, authority, record, signal);
    if (!response.success) throw new SandboxControlError(response.problem.code);
    return response;
  }
  private async exchange(
    request: SandboxControlRequest,
    authority: ControlAuthority,
    record: ControlAuthorityRecord,
    signal: AbortSignal,
  ): Promise<SandboxControlResponse> {
    let directory: SafeDirectory | null = null;
    try {
      directory = SafeDirectory.open(this.configuration.endpointDirectory);
      return await new ControlExchange(
        directory,
        request,
        authority,
        record,
        signal,
        this.configuration.timeoutMs,
      ).run();
    } catch (error) {
      if (error instanceof SandboxControlError) throw error;
      throw new SandboxControlError('SANDBOX_OPERATION_FAILED');
    } finally {
      directory?.close();
    }
  }
  async ready(signal: AbortSignal): Promise<SandboxAvailability> {
    return SandboxControlSchemas.availability.parse(
      (await this.request('ready', {}, signal)).result,
    );
  }
  async create(sandboxId: string, signal: AbortSignal): Promise<SandboxEvidence> {
    return SandboxControlSchemas.evidence.parse(
      (await this.request('create', { sandboxId }, signal)).result,
    );
  }
  async inspect(sandboxId: string, signal: AbortSignal): Promise<SandboxEvidence> {
    return SandboxControlSchemas.evidence.parse(
      (await this.request('inspect', { sandboxId }, signal)).result,
    );
  }
  async assign(
    sandboxId: string,
    assignmentId: string,
    environmentId: string,
    signal: AbortSignal,
  ): Promise<SandboxAssignment> {
    return SandboxControlSchemas.assignment.parse(
      (await this.request('assign', { sandboxId, assignmentId, environmentId }, signal)).result,
    );
  }
  async execute(
    sandboxId: string,
    phase: 'setup' | 'verification',
    signal: AbortSignal,
  ): Promise<SandboxPhaseReceipt> {
    return SandboxControlSchemas.receipt.parse(
      (await this.request('execute', { sandboxId, phase }, signal)).result,
    );
  }
  async destroy(sandboxId: string, signal: AbortSignal): Promise<SandboxDestructionReceipt> {
    return SandboxControlSchemas.destruction.parse(
      (await this.request('destroy', { sandboxId }, signal)).result,
    );
  }
}

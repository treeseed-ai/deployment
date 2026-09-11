import type { SandboxAssignment, SourceCandidateAttestation, SourceCandidateReceipt, SourceWorkspaceAuthorization } from '@treeseed/sdk/capacity-provider/sandbox';
import type { WorkspaceDisk } from './workspace-block-store.js';
import { verifyWorkspaceCandidate, type CandidateOperations } from './workspace-candidate.js';
import { assertCandidateAcceptance, describeCandidateTransfer, readCandidateTransferChunk } from './source-candidate-transfer.js';

export interface CandidateJobOperations extends CandidateOperations {
  current(): { leaseId: string; authorization: SourceWorkspaceAuthorization; disk: WorkspaceDisk };
  detachExecution(disk: WorkspaceDisk): Promise<void>;
}

/** One immutable export per executed overlay. Failed jobs retain storage; no automatic lease stealing. */
export class SourceCandidateJob {
  private state: 'verifying' | 'ready' | 'accepted' | 'retained' = 'verifying';
  private candidate?: SourceCandidateAttestation;
  private bundlePath?: string;
  private receipt?: SourceCandidateReceipt;
  private readonly pending: Promise<void>;
  constructor(private readonly assignment: Pick<SandboxAssignment, 'assignmentId' | 'attempt' | 'providerId'>,
    readonly commit: string, readonly parentCandidateId: string | null, maximum: number, executionStopped: boolean,
    private readonly operations: CandidateJobOperations) {
    this.pending = this.prepare(maximum, executionStopped).catch(async () => {
      this.state = 'retained';
      await operations.journal({ state: this.state, assignmentId: assignment.assignmentId, reason: 'candidate_export_failed' });
    });
    void this.pending.catch(() => { this.state = 'retained'; });
  }
  status() { return { state: this.state, ...(this.candidate ? { candidate: this.candidate } : {}), ...(this.receipt ? { receipt: this.receipt } : {}) }; }
  async drain() { await this.pending.catch(() => undefined); }
  private async prepare(maximum: number, executionStopped: boolean) {
    if (!executionStopped) throw new Error('Execution teardown must precede candidate export.');
    const current = this.operations.current();
    await this.operations.detachExecution(current.disk);
    const result = await verifyWorkspaceCandidate({ ...current, commit: this.commit, maxBytes: maximum, executionStopped }, this.operations);
    const candidate = await describeCandidateTransfer({ assignment: this.assignment, ...current, commit: this.commit,
      parentCandidateId: this.parentCandidateId, bundlePath: result.bundlePath, bytes: result.verification.bytes,
      digest: result.digest, verifiedAt: this.operations.now().toISOString() });
    await this.operations.journal({ state: 'ready', candidate, bundlePath: result.bundlePath });
    this.bundlePath = result.bundlePath; this.candidate = candidate; this.state = 'ready';
  }
  async chunk(index: number) {
    this.operations.current();
    if (!this.candidate || !this.bundlePath || !['ready', 'accepted'].includes(this.state)) throw new Error('Candidate is not ready for transfer.');
    return readCandidateTransferChunk(this.bundlePath, this.candidate, index);
  }
  async accept(value: unknown) {
    const current = this.operations.current();
    if (!this.candidate || !['ready', 'accepted'].includes(this.state)) throw new Error('Candidate is not independently verified.');
    if (current.leaseId !== this.candidate.leaseId || current.authorization.publication !== 'candidate-only') throw new Error('Candidate authority changed.');
    const receipt = assertCandidateAcceptance(this.candidate, value);
    if (this.state === 'accepted') return this.receipt!;
    await this.operations.journal({ state: 'accepted', candidate: this.candidate, receipt, bundlePath: this.bundlePath });
    this.receipt = receipt; this.state = 'accepted';
    return receipt;
  }
  acceptedReceipt() { return this.state === 'accepted' ? this.receipt : undefined; }
}

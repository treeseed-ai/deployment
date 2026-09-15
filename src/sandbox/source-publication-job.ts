import type { SandboxAssignment, SourceWorkspaceAuthorization } from '@treeseed/sdk/capacity-provider/sandbox';
import type { WorkspaceDisk } from './workspace-block-store.js';
import { verifyWorkspaceCandidate, type CandidateOperations } from './workspace-candidate.js';

export interface SourcePublicationOperations extends CandidateOperations {
	current(): { leaseId: string; authorization: SourceWorkspaceAuthorization; disk: WorkspaceDisk };
	detachExecution(disk: WorkspaceDisk): Promise<void>;
	publish(bundlePath: string): Promise<{ kind: 'git'; repository: string; commit: string; branch: string }>;
}

/** One independently verified publication per executed overlay. Failures retain storage for recovery. */
export class SourcePublicationJob {
	private state: 'verifying' | 'published' | 'retained' = 'verifying';
	private reference?: { kind: 'git'; repository: string; commit: string; branch: string };
	private failure?: string;
	private readonly pending: Promise<void>;
	constructor(private readonly assignment: Pick<SandboxAssignment, 'assignmentId' | 'attempt' | 'providerId'>,
		readonly commit: string, maximum: number, executionStopped: boolean,
		private readonly operations: SourcePublicationOperations) {
		this.pending = this.prepare(maximum, executionStopped).catch(async (error: unknown) => {
			this.state = 'retained';
			this.failure = error instanceof Error ? error.message.slice(0, 768) : 'Unknown source publication failure.';
			await operations.journal({ state: this.state, assignmentId: assignment.assignmentId,
				reason: 'source_publication_failed', detail: this.failure });
		});
		void this.pending.catch(() => { this.state = 'retained'; });
	}
	status() { return { state: this.state, ...(this.reference ? { reference: this.reference } : {}), ...(this.failure ? { failure: this.failure } : {}) }; }
	async drain() { await this.pending.catch(() => undefined); }
	private async prepare(maximum: number, executionStopped: boolean) {
		if (!executionStopped) throw new Error('Execution teardown must precede source publication.');
		const current = this.operations.current();
		await this.operations.detachExecution(current.disk);
		const result = await verifyWorkspaceCandidate({ ...current, commit: this.commit, maxBytes: maximum, executionStopped }, this.operations);
		this.reference = await this.operations.publish(result.bundlePath);
		if (this.reference.commit !== this.commit) throw new Error('Published source reference changed the verified commit.');
		await this.operations.journal({ state: 'published', assignmentId: this.assignment.assignmentId,
			attempt: this.assignment.attempt, providerId: this.assignment.providerId, reference: this.reference });
		this.state = 'published';
	}
	publishedReference() { return this.state === 'published' ? this.reference : undefined; }
}

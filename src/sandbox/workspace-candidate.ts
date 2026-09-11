import type { SourceWorkspaceAuthorization } from '@treeseed/sdk/capacity-provider/sandbox';
import type { WorkspaceDisk } from './workspace-block-store.js';

export interface CandidateVerification {
  baseCommit: string;
  commit: string;
  bytes: number;
  clean: true;
  objectClosure: true;
  ancestry: true;
  isolatedVerifier: true;
}
export interface CandidateOperations {
  now(): Date;
  journal(value: Record<string, unknown>): Promise<void>;
  verify(input: { disk: WorkspaceDisk; baseCommit: string; commit: string; maxBytes: number }): Promise<{
    verification: CandidateVerification; bundlePath: string; digest: string; verifierStopped: boolean;
  }>;
}

/** Execution teardown precedes verification. Durable publication is a separate, reauthorized step. */
export async function verifyWorkspaceCandidate(input: {
  leaseId: string; authorization: SourceWorkspaceAuthorization; disk: WorkspaceDisk;
  commit: string; maxBytes: number; executionStopped: boolean;
}, operations: CandidateOperations) {
  const authority = input.authorization;
  const assertAuthority = () => {
    if (authority.mode !== 'work' || authority.publication !== 'candidate-only'
      || Date.parse(authority.expiresAt) <= operations.now().getTime()) throw new Error('Candidate export requires current work publication authority.');
  };
  assertAuthority();
  if (!input.executionStopped) throw new Error('Candidate verification requires verified execution VM teardown.');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(input.commit)
    || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) throw new Error('Candidate verification input is invalid.');
  const custody = { leaseId: input.leaseId, authorizationId: authority.id, source: authority.source,
    diskId: input.disk.id, commit: input.commit };
  await operations.journal({ ...custody, state: 'verifying', executionStopped: true });
  try {
    const result = await operations.verify({ disk: input.disk, baseCommit: authority.source.commit,
      commit: input.commit, maxBytes: input.maxBytes });
    const verification = result.verification;
    if (!result.verifierStopped || verification.baseCommit !== authority.source.commit || verification.commit !== input.commit
      || verification.clean !== true || verification.objectClosure !== true || verification.ancestry !== true
      || verification.isolatedVerifier !== true || !Number.isSafeInteger(verification.bytes) || verification.bytes < 1
      || verification.bytes > input.maxBytes || !/^sha256:[a-f0-9]{64}$/u.test(result.digest)) throw new Error('Independent candidate verification failed.');
    // Verification can outlive a lease; this result never grants publication by itself.
    await operations.journal({ ...custody, state: 'verified', verification, digest: result.digest, verifierStopped: true });
    return result;
  } catch (error) {
    await operations.journal({ ...custody, state: 'retained', reason: 'candidate_verification_failed' });
    throw error;
  }
}

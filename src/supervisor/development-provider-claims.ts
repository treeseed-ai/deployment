import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function activeAgentClaims(stateRoot: string, providerHandoff = false) {
	const path = resolve(stateRoot, 'runtime', 'capacity-state.json');
	if (!existsSync(path)) return [];
	const state = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion?: unknown; claims?: unknown };
	if (state.schemaVersion !== 1 || !Array.isArray(state.claims)) throw new Error('Provider-local capacity state is invalid.');
	return state.claims.filter((claim): claim is { id: string; status: string } => {
		if (!claim || typeof claim !== 'object') throw new Error('Provider-local capacity claim is invalid.');
		const value = claim as Record<string, unknown>;
		if (typeof value.id !== 'string' || !['polling', 'ready', 'running', 'recovery', 'unresolved'].includes(String(value.status)))
			throw new Error('Provider-local capacity claim is invalid.');
		// The owning provider retains unresolved usage custody and period holds;
		// this reader only observes whether a live execution slot blocks handoff.
		if (providerHandoff && value.status === 'recovery') {
			// Replace only provider code after its trusted executor physically closed.
			// The complete recovery journal and accounting holds remain untouched.
			const output = value.closeoutOutput as Record<string, unknown> | undefined;
			const teardown = output?.teardown as Record<string, unknown> | undefined;
			const completed = typeof teardown?.completedAt === 'string' ? Date.parse(teardown.completedAt) : NaN;
			const started = typeof value.activeStartedAt === 'string' ? Date.parse(value.activeStartedAt) : NaN;
			const finished = typeof value.activeFinishedAt === 'string' ? Date.parse(value.activeFinishedAt) : NaN;
			const frozen = (value.dispatchEnvelope as { assignment?: { assignmentAttempt?: Record<string, unknown> } } | undefined)?.assignment?.assignmentAttempt;
			const workspace = frozen?.workspace as Record<string, unknown> | undefined;
			const result = output?.assignmentResult as Record<string, unknown> | undefined;
			// Native Kernel work may close an empty resource scope before the enclosing
			// provider stops accounting. This permits code handoff only: the new
			// provider must still verify original authority, results and settlement.
			const nativeClosed = output && !Object.hasOwn(output, 'sandboxId')
				&& Object.keys(output).every(key => ['assignmentResult', 'teardown', 'artifacts'].includes(key))
				&& Array.isArray(output.artifacts) && output.artifacts.length === 0
				&& typeof value.assignmentId === 'string' && frozen?.id === value.assignmentId && result?.assignmentId === value.assignmentId
				&& workspace?.mode === 'treedx' && result?.status === 'completed'
				&& typeof result.completedAt === 'string' && Number.isFinite(Date.parse(result.completedAt))
				&& started <= Date.parse(result.completedAt) && Date.parse(result.completedAt) <= completed && completed <= finished
				&& value.accountedThrough === value.activeFinishedAt;
			if (nativeClosed && teardown?.verified === true && Number.isFinite(completed) && completed <= Date.now()
				&& Number.isFinite(started) && Number.isFinite(finished) && started <= finished && finished <= Date.now()) return false;
			if (typeof output?.sandboxId === 'string' && output.sandboxId && teardown?.verified === true
				&& Number.isFinite(completed) && completed <= Date.now()
				&& Number.isFinite(started) && Number.isFinite(finished) && started <= finished && finished <= completed) return false;
		}
		return value.status !== 'polling' && value.status !== 'unresolved';
	});
}

export function expiredRecoveryClaim(value: unknown) {
	const row = (input: unknown): Record<string, unknown> => input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
	const claim = row(value), assignment = row(row(claim.dispatchEnvelope).assignment), attempt = row(assignment.assignmentAttempt);
	const clock = (input: unknown) => typeof input === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/u.test(input) ? Date.parse(input) : NaN;
	const deadline = clock(attempt.deadline), lease = clock(claim.leaseExpiresAt), start = clock(claim.activeStartedAt), now = Date.now();
	// The provider records this original start after authenticated execution-start.
	// Its frozen productive limit can expire before the enclosing workday deadline.
	const maximumSeconds = row(attempt.limits).maximumSeconds;
	const executionDeadline = typeof maximumSeconds === 'number' && Number.isSafeInteger(maximumSeconds) && maximumSeconds > 0
		&& Number.isSafeInteger(start + maximumSeconds * 1_000) ? start + maximumSeconds * 1_000 : NaN;
	return claim.status === 'recovery' && typeof claim.assignmentId === 'string' && claim.assignmentId.length > 0
		&& attempt.schemaVersion === 'treeseed.assignment-attempt/v1' && attempt.id === claim.assignmentId
		&& Number.isFinite(deadline) && Number.isFinite(lease) && Number.isFinite(start) && start <= deadline
		&& Math.min(deadline, Number.isFinite(executionDeadline) ? executionDeadline : deadline) <= now && lease <= now;
}

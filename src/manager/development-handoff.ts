import type { ManagedDevelopmentSession } from './development-sessions.js';
import { requestSupervisor } from '../supervisor/client.js';

export function sandboxGuestTrustDigest(releasedDigest: string | undefined, heldByDevelopmentSession: boolean) {
	// The candidate import binds exact guest trust; released reconciliation must not replace it mid-session.
	return heldByDevelopmentSession ? undefined : releasedDigest;
}

/** Only a runtime target can replace an installed component. A package watch
 * changes source custody but must leave the released service running. */
export function developmentHeldComponentIds(records: readonly ManagedDevelopmentSession[]) {
	return new Set(records.flatMap((record) => record.session.targets.filter((target) =>
		target.mode !== 'released' && record.runtimes.some((runtime) => runtime.project.id === target.projectId
			&& runtime.targets.some((candidate) => candidate.id === target.targetId && candidate.kind !== 'package-watch')))
		.map((target) => target.projectId)));
}

/** A development-held service resumes from its pinned source, never its older released writer. */
export function runtimeActivationTargets<T extends { componentId: string }>(ordered: T[], heldIds: ReadonlySet<string>, changedIds: ReadonlySet<string>, configurationImpacts: (componentId: string) => boolean): T[] {
	return ordered.filter(({ componentId }) => !heldIds.has(componentId) && (configurationImpacts(componentId) || changedIds.has(componentId)));
}

/** Backups discard ephemeral keys; restore only held services before resuming their existing runtimes. */
export async function restoreHeldComponentCredentials<T extends { componentId: string }>(ordered: readonly T[], heldIds: ReadonlySet<string>, configure: (component: T) => Promise<unknown>) {
	for (const component of ordered) if (heldIds.has(component.componentId)) await configure(component);
}

export function heldDevelopmentCredentialsMissing(status: { issues?: Array<{ reason: string }> }) {
	return status.issues?.some(({ reason }) => reason === 'runtime-credential-unavailable' || reason === 'configuration-unavailable') === true;
}

/** Schedule source recovery only after its released dependencies are ready. */
export async function resumeDevelopmentSessions(records: readonly ManagedDevelopmentSession[]) {
	const results = await Promise.allSettled(records.map((record) => requestSupervisor<{ ready: boolean }>({
		operation: 'development.boot.resume', sessionId: record.session.sessionId,
	})));
	return results.every((result) => result.status === 'fulfilled' && result.value.ready);
}

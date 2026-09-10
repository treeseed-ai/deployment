import type { ComponentRelease } from '@treeseed/sdk/deployment';

/** Capture the whole generation only after every declared writer is stopped. */
export async function quiescedBackup(
	stopOrder: ComponentRelease[], startOrder: ComponentRelease[],
	operations: { stop: (component: ComponentRelease) => Promise<unknown>; start: (component: ComponentRelease) => Promise<unknown>; capture: () => Promise<unknown>; rollbackConfiguration?: () => Promise<unknown>;
		prepare?: () => Promise<unknown>; resumeAfterFailure?: () => Promise<unknown> },
) {
	// Preparation validates all writers before disturbing released services. A
	// partial preparation failure owns its own candidate containment/recovery.
	await operations.prepare?.();
	try {
		for (const component of stopOrder) await operations.stop(component);
		await operations.capture();
	} catch (error) {
		await operations.rollbackConfiguration?.();
		for (const component of startOrder) await operations.start(component);
		await operations.resumeAfterFailure?.();
		throw error;
	}
}

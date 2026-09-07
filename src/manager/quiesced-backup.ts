import type { ComponentRelease } from '@treeseed/sdk/deployment';

/** Capture the whole generation only after every declared writer is stopped. */
export async function quiescedBackup(
	stopOrder: ComponentRelease[], startOrder: ComponentRelease[],
	operations: { stop: (component: ComponentRelease) => Promise<unknown>; start: (component: ComponentRelease) => Promise<unknown>; capture: () => Promise<unknown>; rollbackConfiguration?: () => Promise<unknown> },
) {
	try {
		for (const component of stopOrder) await operations.stop(component);
		await operations.capture();
	} catch (error) {
		await operations.rollbackConfiguration?.();
		for (const component of startOrder) await operations.start(component);
		throw error;
	}
}

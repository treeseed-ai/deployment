import { assertDevelopmentNotHeld } from '../core/development-backup-hold.js';
import { loadHostConfiguration } from '../core/configuration.js';
import { loadActiveComponents, loadCurrentReceipt } from './current-state.js';
import { componentStopOrder } from './component-order.js';
import { DevelopmentSessionStore } from './development-sessions.js';
import { reconcile, stopComponent } from './reconcile.js';
import { runtimeStopped, setRuntimeStopped } from './update-state.js';

/** The manager and supervisor remain reachable; only selected workloads stop. */
export async function stopHostWorkloads() {
	assertDevelopmentNotHeld();
	const live = new DevelopmentSessionStore().list()
		.filter(record => record.session.status !== 'suspended' && record.session.targets.some(target => target.mode !== 'released'));
	if (live.length) throw new Error('Active development targets require a coordinated development pause before host stop. No services were changed.');
	if (runtimeStopped()) return { state: 'stopped' as const, changed: false };
	const host = loadHostConfiguration(), active = loadActiveComponents();
	setRuntimeStopped(true);
	const failures: string[] = [];
	for (const component of componentStopOrder(host, active)) {
		try { await stopComponent(component); }
		catch { failures.push(component.componentId); }
	}
	if (failures.length) throw new Error(`Host stop retained the restart fence, but these components need recovery: ${failures.join(', ')}.`);
	return { state: 'stopped' as const, changed: true };
}

/** A failed start stays fenced so timers cannot retry behind the operator's back. */
export async function startHostWorkloads() {
	assertDevelopmentNotHeld();
	if (!runtimeStopped()) return { state: 'running' as const, changed: false, receipt: loadCurrentReceipt() };
	setRuntimeStopped(false);
	try {
		const receipt = await reconcile();
		return { state: 'running' as const, changed: true, receipt };
	} catch (error) {
		setRuntimeStopped(true);
		const host = loadHostConfiguration(), active = loadActiveComponents();
		for (const component of componentStopOrder(host, active)) {
			try { await stopComponent(component); } catch { /* retain the restart fence and original failure */ }
		}
		throw error;
	}
}

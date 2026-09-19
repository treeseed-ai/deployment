import type { HostConfiguration } from '@treeseed/sdk/deployment';
import { configurationPlan } from './configuration-preflight.js';
import { serializedHostConfigurationStage, serializedHostLifecycle } from './serialized-reconcile.js';
import { runtimeStopped } from './update-state.js';

/** The local manager socket is the only authority for whole-host lifecycle changes. */
export async function executeHostLifecycleCommand(request: {
	handlerId: 'local.host.start' | 'local.host.stop' | 'local.host.config.stage';
	options: Record<string, unknown>;
	configuration?: HostConfiguration | undefined;
}, local: boolean) {
	if (!local) throw new Error('Host lifecycle control is available only through the protected local manager socket.');
	if (request.handlerId === 'local.host.config.stage') {
		if (!runtimeStopped()) throw new Error('Stop host workloads before staging a configuration without activation.');
		if (!request.configuration) throw new Error('A current-format host configuration is required.');
		const candidate = request.configuration, proposed = configurationPlan(candidate);
		if (request.options.plan === true) return proposed;
		if (proposed.plan.blockers.length) throw new Error('Host configuration plan has unresolved blockers.');
		return serializedHostConfigurationStage(candidate);
	}
	const action = request.handlerId === 'local.host.start' ? 'start' : 'stop';
	return request.options.plan === true
		? { action, lifecycle: runtimeStopped() ? 'stopped' as const : 'running' as const, mutation: false }
		: serializedHostLifecycle(action);
}

import type { HostConfiguration } from '@treeseed/sdk/deployment';

/** Component activation and its database requirement are one configuration change. */
export function setComponentEnabled(host: HostConfiguration, componentId: string, enabled: boolean): HostConfiguration {
	const component = host.components[componentId];
	if (!component) throw new Error(`Unknown configured component ${componentId}.`);
	component.enabled = enabled;
	for (const requirement of host.postgres?.requirements ?? []) {
		if (requirement.componentId === componentId) requirement.enabled = enabled;
	}
	return host;
}

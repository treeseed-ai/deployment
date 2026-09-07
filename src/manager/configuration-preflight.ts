import type { ComponentRelease, HostConfiguration } from '@treeseed/sdk/deployment';
import { componentActivationInputs } from './reconcile.js';
import { existsSync } from 'node:fs';
import { loadCatalog } from '../catalog/load.js';
import { paths } from '../core/paths.js';
import { createPlan } from './plan.js';
import { loadCurrentReceipt } from './current-state.js';

export function configurationPlan(configuration: HostConfiguration) {
	const stable = loadCatalog(`${paths.catalogs}/stable.json`), developmentPath = `${paths.catalogs}/development.json`;
	const proposed = createPlan(configuration, stable, existsSync(developmentPath) ? loadCatalog(developmentPath) : undefined, loadCurrentReceipt() ?? undefined);
	assertConfigurationRuntimeInputs(configuration, proposed.components);
	return proposed;
}

/** Validate public runtime inputs against the selected releases before changing custody. */
export function assertConfigurationRuntimeInputs(host: HostConfiguration, components: ComponentRelease[]) {
	for (const component of components) componentActivationInputs(host, component, components);
}

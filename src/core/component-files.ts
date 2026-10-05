import type { ComponentRelease } from '@treeseed/sdk/deployment';

/** Resolve immutable package defaults without turning them into host overrides. */
export function componentManagedFiles(component: ComponentRelease, configured: Record<string, unknown> = {}) {
	const declarations = component.runtime.configuration.files;
	const files: Record<string, string> = {};
	for (const key of Object.keys(configured)) {
		if (!declarations.some(({ id }) => id === key)) throw new Error(`Undeclared managed file ${key}.`);
	}
	for (const declaration of declarations) {
		if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(declaration.id) || declaration.path !== `/etc/treeseed/components/${component.componentId}/${declaration.id}`) throw new Error(`Invalid managed file path ${declaration.id}.`);
		const value = configured[declaration.id] === undefined ? declaration.default : configured[declaration.id];
		if (value === undefined) {
			if (declaration.required) throw new Error(`Required managed file ${declaration.id} is not configured for ${component.componentId}.`);
			continue;
		}
		if (typeof value !== 'string' || value.length > 1_048_576) throw new Error(`Invalid managed file content ${declaration.id}.`);
		files[declaration.id] = value;
	}
	return files;
}

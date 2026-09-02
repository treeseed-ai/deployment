import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const names = ['versions.tf', 'variables.tf', 'main.tf', 'outputs.tf', '.terraform.lock.hcl'] as const;

function moduleRoot() {
	const candidates = [
		new URL('../../../../infrastructure/opentofu/hosted-topology/', import.meta.url),
		new URL('../../../infrastructure/opentofu/hosted-topology/', import.meta.url),
	];
	const selected = candidates.find((candidate) => existsSync(fileURLToPath(new URL('versions.tf', candidate))));
	if (!selected) throw new Error('Deployment hosted infrastructure module is missing from the installed artifact.');
	return selected;
}

export function hostedInfrastructureModuleFiles() {
	const root = moduleRoot();
	return Object.fromEntries(names.map((name) => [name, readFileSync(fileURLToPath(new URL(name, root)), 'utf8')])) as Record<(typeof names)[number], string>;
}

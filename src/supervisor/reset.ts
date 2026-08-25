import { mkdirSync, rmSync } from 'node:fs';
import { paths } from '../core/paths.js';

export interface PlatformResetPaths {
	components: string;
	componentConfiguration: string;
	managerState: string;
	backups: string;
}

const resetStateNames = [
	'active-components.json',
	'current-receipt.json',
	'events.jsonl',
	'last-apt-result.json',
	'pending-packages.json',
	'update-state.json',
	'invalid-state',
	'provider-enrollments',
	'receipts',
] as const;

export function resetPlatformState(targets: PlatformResetPaths = {
	components: paths.components,
	componentConfiguration: '/etc/treeseed/components',
	managerState: paths.managerState,
	backups: paths.backups,
}) {
	rmSync(targets.components, { recursive: true, force: true });
	rmSync(targets.componentConfiguration, { recursive: true, force: true });
	rmSync(targets.backups, { recursive: true, force: true });
	for (const name of resetStateNames) rmSync(`${targets.managerState}/${name}`, { recursive: true, force: true });
	mkdirSync(targets.components, { recursive: true, mode: 0o700 });
	mkdirSync(targets.componentConfiguration, { recursive: true, mode: 0o750 });
	mkdirSync(`${targets.managerState}/receipts`, { recursive: true, mode: 0o750 });
	mkdirSync(targets.backups, { recursive: true, mode: 0o700 });
	return { reset: true, removed: ['component-data', 'component-configuration', 'manager-receipts', 'provider-enrollments', 'update-state', 'backups'] };
}

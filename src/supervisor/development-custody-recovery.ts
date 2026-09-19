import { existsSync } from 'node:fs';

/** A surviving vault identity alone does not prove that ephemeral API keys survived host stop. */
export function developmentCustodyReady(paths = [
	'/run/treeseed/openbao/client/identity.json',
	'/run/treeseed/component-credentials/api/credentials',
	'/run/treeseed/component-credentials/api/diagnostics',
]) {
	return paths.every(path => existsSync(path));
}

/** Rebind ephemeral inputs even when Docker auto-started an unhealthy old container. */
export function recoveredVaultStartArguments(compose: string[]) {
	return [...compose, 'up', '--detach', '--force-recreate', '--wait', '--wait-timeout', '120', 'openbao'];
}

/** Idempotent boot recovery; a failed prerequisite must never start consumers. */
export function recoverDevelopmentCustody(operations: {
	ready: () => boolean;
	prepare: () => void;
	startVault: () => void;
	initializeClient: () => void;
}) {
	if (operations.ready()) return false;
	for (const stage of ['prepare', 'startVault', 'initializeClient'] as const) {
		try { operations[stage](); }
		catch (cause) { throw new Error(`Managed API custody recovery failed at ${stage}.`, { cause }); }
	}
	if (!operations.ready()) throw new Error('Managed API custody recovery did not produce a client identity.');
	return true;
}

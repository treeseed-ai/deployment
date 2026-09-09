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

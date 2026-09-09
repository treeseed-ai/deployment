/** Idempotent boot recovery; a failed prerequisite must never start consumers. */
export function recoverDevelopmentCustody(operations: {
	ready: () => boolean;
	prepare: () => void;
	startVault: () => void;
	initializeClient: () => void;
}) {
	if (operations.ready()) return false;
	operations.prepare();
	operations.startVault();
	operations.initializeClient();
	if (!operations.ready()) throw new Error('Managed API custody recovery did not produce a client identity.');
	return true;
}

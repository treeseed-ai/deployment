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

function safeRecoveryCause(cause: unknown) {
	const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : null;
	if (typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/iu.test(code)) return code.toUpperCase();
	if (cause instanceof Error && cause.message === 'Existing OpenBao state requires its original OS custody; recovery is required.')
		return 'OPENBAO_OS_CUSTODY_MISSING';
	if (cause instanceof Error) {
		const conflict = /^Environment entry ([A-Z][A-Z0-9_]{0,49}) is reserved for a managed connection\.$/u.exec(cause.message);
		if (conflict) return `ENVIRONMENT_CONFLICT_${conflict[1]}`;
		const invalid = /^Invalid (?:secret )?environment entry ([A-Z][A-Z0-9_]{0,49})\.$/u.exec(cause.message);
		if (invalid) return `ENVIRONMENT_INVALID_${invalid[1]}`;
		const functions = (cause.stack ?? '').split('\n').slice(1, 5).flatMap(line => {
			const name = /\bat ([A-Za-z][A-Za-z0-9_]{0,39})\b/u.exec(line)?.[1];
			return name ? [name.toUpperCase()] : [];
		});
		if (functions.length) return `UNCLASSIFIED_${functions.slice(0, 2).join('_')}`;
	}
	return 'UNCLASSIFIED';
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
		catch (cause) { throw new Error(`Managed development diagnostic failed (API_CUSTODY_${stage.toUpperCase()}_${safeRecoveryCause(cause)}).`, { cause }); }
	}
	if (!operations.ready()) throw new Error('Managed API custody recovery did not produce a client identity.');
	return true;
}

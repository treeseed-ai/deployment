import { expect, it } from 'vitest';
import { recoverDevelopmentCustody, recoveredVaultStartArguments } from '../src/supervisor/development-custody-recovery.js';

it('recreates only the vault process after runtime reconstruction, without deleting storage', () => {
	expect(recoveredVaultStartArguments(['compose', '--file', '/managed/compose.json'])).toEqual([
		'compose', '--file', '/managed/compose.json', 'up', '--detach', '--force-recreate', '--wait', '--wait-timeout', '120', 'openbao',
	]);
});

it('reports the failing recovery stage without reflecting sensitive backend errors', () => {
	for (const stage of ['prepare', 'startVault', 'initializeClient'] as const) {
		const operations = { ready: () => false, prepare: () => {}, startVault: () => {}, initializeClient: () => {} };
		operations[stage] = () => { throw new Error('private-bootstrap-value'); };
		expect(() => recoverDevelopmentCustody(operations)).toThrow(`Managed API custody recovery failed at ${stage}.`);
	}
});

it('restores boot inputs before vault startup and client recovery, then noops', () => {
	const calls: string[] = []; let ready = false;
	const operations = { ready: () => ready, prepare: () => { calls.push('prepare'); },
		startVault: () => { calls.push('vault'); }, initializeClient: () => { calls.push('client'); ready = true; } };
	expect(recoverDevelopmentCustody(operations)).toBe(true);
	expect(recoverDevelopmentCustody(operations)).toBe(false);
	expect(calls).toEqual(['prepare', 'vault', 'client']);
});
it('does not initialize a client after failed vault startup', () => {
	let initialized = false;
	expect(() => recoverDevelopmentCustody({ ready: () => false, prepare: () => {},
		startVault: () => { throw new Error('sealed'); }, initializeClient: () => { initialized = true; } })).toThrow('startVault');
	expect(initialized).toBe(false);
});
it('rejects successful initializer exit without the required identity', () => {
	expect(() => recoverDevelopmentCustody({ ready: () => false, prepare: () => {}, startVault: () => {}, initializeClient: () => {} })).toThrow('did not produce');
});

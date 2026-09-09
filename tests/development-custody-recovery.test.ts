import { expect, it } from 'vitest';
import { recoverDevelopmentCustody } from '../src/supervisor/development-custody-recovery.js';

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
		startVault: () => { throw new Error('sealed'); }, initializeClient: () => { initialized = true; } })).toThrow('sealed');
	expect(initialized).toBe(false);
});
it('rejects successful initializer exit without the required identity', () => {
	expect(() => recoverDevelopmentCustody({ ready: () => false, prepare: () => {}, startVault: () => {}, initializeClient: () => {} })).toThrow('did not produce');
});

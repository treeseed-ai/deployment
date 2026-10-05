import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { developmentCustodyReady, recoverDevelopmentCustody, recoveredVaultStartArguments } from '../src/supervisor/development-custody-recovery.js';

it('requires both the vault identity and ephemeral API credential files after a stop/start', () => {
	const root = mkdtempSync(resolve(tmpdir(), 'treeseed-development-custody-'));
	try {
		const paths = ['identity.json', 'credentials', 'diagnostics'].map(name => resolve(root, name));
		expect(developmentCustodyReady(paths)).toBe(false);
		writeFileSync(paths[0]!, '{}');
		expect(developmentCustodyReady(paths)).toBe(false);
		writeFileSync(paths[1]!, 'encrypted');
		expect(developmentCustodyReady(paths)).toBe(false);
		writeFileSync(paths[2]!, 'encrypted');
		expect(developmentCustodyReady(paths)).toBe(true);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

it('recreates only the vault process after runtime reconstruction, without deleting storage', () => {
	expect(recoveredVaultStartArguments(['compose', '--file', '/managed/compose.json'])).toEqual([
		'compose', '--file', '/managed/compose.json', 'up', '--detach', '--force-recreate', '--wait', '--wait-timeout', '120', 'openbao',
	]);
});

it('reports the failing recovery stage without reflecting sensitive backend errors', () => {
	for (const stage of ['prepare', 'startVault', 'initializeClient'] as const) {
		const operations = { ready: () => false, prepare: () => {}, startVault: () => {}, initializeClient: () => {} };
		operations[stage] = () => { throw new Error('private-bootstrap-value'); };
		expect(() => recoverDevelopmentCustody(operations)).toThrow(new RegExp(`API_CUSTODY_${stage.toUpperCase()}_UNCLASSIFIED(?:_[A-Z0-9_]+)?`));
	}
});

it('reports only a bounded custody error code, never secret-bearing error prose', () => {
	const privateMessage = 'secret value must remain private';
	const coded = Object.assign(new Error(privateMessage), { code: 'os_credential_unavailable' });
	let error: Error | undefined;
	try { recoverDevelopmentCustody({ ready: () => false, prepare: () => { throw coded; }, startVault: () => {}, initializeClient: () => {} }); }
	catch (cause) { error = cause as Error; }
	expect(error?.message).toBe('Managed development diagnostic failed (API_CUSTODY_PREPARE_OS_CREDENTIAL_UNAVAILABLE).');
	expect(error?.message).not.toContain(privateMessage);
});

it('identifies a managed environment conflict by key without printing its value', () => {
	expect(() => recoverDevelopmentCustody({ ready: () => false,
		prepare: () => { throw new Error('Environment entry TREESEED_TREEDX_URL is reserved for a managed connection.'); },
		startVault: () => {}, initializeClient: () => {} })).toThrow('API_CUSTODY_PREPARE_ENVIRONMENT_CONFLICT_TREESEED_TREEDX_URL');
});

it('restores boot inputs before vault startup and client recovery, then noops', () => {
	const calls: string[] = []; let ready = false;
	const operations = { ready: () => ready, prepare: () => { calls.push('prepare'); },
		startVault: () => { calls.push('vault'); }, initializeClient: () => { calls.push('client'); ready = true; } };
	expect(recoverDevelopmentCustody(operations)).toBe(true);
	expect(recoverDevelopmentCustody(operations)).toBe(false);
	expect(calls).toEqual(['prepare', 'vault', 'client']);
});
it('restarts vault custody when credential files survive but the vault stopped', () => {
	let vaultRunning = false; const calls: string[] = [];
	const operations = { ready: () => vaultRunning, prepare: () => { calls.push('prepare'); },
		startVault: () => { calls.push('vault'); vaultRunning = true; }, initializeClient: () => { calls.push('client'); } };
	expect(recoverDevelopmentCustody(operations)).toBe(true);
	expect(calls).toEqual(['prepare', 'vault', 'client']);
});
it('does not initialize a client after failed vault startup', () => {
	let initialized = false;
	expect(() => recoverDevelopmentCustody({ ready: () => false, prepare: () => {},
		startVault: () => { throw new Error('sealed'); }, initializeClient: () => { initialized = true; } })).toThrow('API_CUSTODY_STARTVAULT_UNCLASSIFIED');
	expect(initialized).toBe(false);
});
it('rejects successful initializer exit without the required identity', () => {
	expect(() => recoverDevelopmentCustody({ ready: () => false, prepare: () => {}, startVault: () => {}, initializeClient: () => {} })).toThrow('did not produce');
});

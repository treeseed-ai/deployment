import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostSecurityActivationBlockers, reconcileExecutionError } from '../src/index.js';

describe('required host security activation blocker', () => {
	it('stops required-security activation before sandbox trust until every prerequisite is ready', () => {
		const incomplete = { backingExists: true, mapperOpen: true, mounted: true, credentialKeksReady: false,
			recoveryBundleVerified: false, sandboxSocketReady: false };
		expect(hostSecurityActivationBlockers(true, incomplete)).toEqual(['credentialKeksReady', 'recoveryBundleVerified', 'sandboxSocketReady']);
		expect(hostSecurityActivationBlockers(false, incomplete)).toEqual([]);
		expect(hostSecurityActivationBlockers(true, { ...incomplete, credentialKeksReady: true, recoveryBundleVerified: true, sandboxSocketReady: true })).toEqual([]);
		const source = readFileSync(resolve(process.cwd(), 'src/manager/reconcile.ts'), 'utf8');
		expect(source.indexOf('host_security_initialization_required')).toBeLessThan(source.indexOf("operation: 'sandbox.trust-anchor.repair'"));
	});

	it('preserves the stable blocker across serialized reconciliation', () => {
		const mapped = reconcileExecutionError({ stderr: 'Error: host_security_initialization_required' }) as Error & { code: string; status: number };
		expect(mapped).toMatchObject({ code: 'host_security_initialization_required', status: 409 });
		expect(mapped.message).toContain('trsd host security initialize');
		const original = new Error('unrelated');
		expect(reconcileExecutionError(original)).toBe(original);
	});
});

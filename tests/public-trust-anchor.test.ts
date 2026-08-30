import { describe, expect, it } from 'vitest';
import { repairSandboxTrustAnchor } from '../src/supervisor/execute.js';
import { supervisorOperationSchema } from '../src/supervisor/protocol.js';

describe('public sandbox trust anchor reconciliation', () => {
	it('repairs the relay CA through a fixed supervisor operation', () => {
		const changes: Array<[string, number]> = [];
		expect(supervisorOperationSchema.parse({ operation: 'sandbox.trust-anchor.repair' })).toEqual({ operation: 'sandbox.trust-anchor.repair' });
		expect(repairSandboxTrustAnchor({
			exists: () => true,
			chmod: (path, mode) => changes.push([String(path), Number(mode)]),
		})).toMatchObject({ repaired: true, mode: '0644' });
		expect(changes).toEqual([['/etc/treeseed/sandbox/relay-ca.crt', 0o644]]);
	});

	it('does nothing when the trust anchor is absent', () => {
		const changes: Array<[string, number]> = [];
		expect(repairSandboxTrustAnchor({
			exists: () => false,
			chmod: (path, mode) => changes.push([String(path), Number(mode)]),
		})).toEqual({ repaired: false, reason: 'not_initialized' });
		expect(changes).toEqual([]);
	});
});

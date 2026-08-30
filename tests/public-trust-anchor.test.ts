import { describe, expect, it } from 'vitest';
import { reconcilePublicTrustAnchors } from '../src/manager/reconcile.js';
import { host } from './fixtures.js';

describe('public sandbox trust anchor reconciliation', () => {
	it('repairs the relay CA mode on every managed reconciliation', () => {
		const changes: Array<[string, number]> = [];
		reconcilePublicTrustAnchors(host(), {
			exists: () => true,
			chmod: (path, mode) => changes.push([String(path), Number(mode)]),
		});
		expect(changes).toEqual([['/etc/treeseed/sandbox/relay-ca.crt', 0o644]]);
	});

	it('does nothing when the agent or trust anchor is absent', () => {
		const configuration = host();
		configuration.components.agent!.enabled = false;
		const changes: Array<[string, number]> = [];
		reconcilePublicTrustAnchors(configuration, {
			exists: () => true,
			chmod: (path, mode) => changes.push([String(path), Number(mode)]),
		});
		expect(changes).toEqual([]);
	});
});

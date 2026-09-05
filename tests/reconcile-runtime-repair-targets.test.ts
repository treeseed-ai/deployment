import { describe, expect, it } from 'vitest';
import { runtimeRepairTargets } from '../src/manager/reconcile.js';

describe('pre-install runtime repair selection', () => {
	it('does not probe uninstalled upgrade or new-component Compose paths', () => {
		const upgrade = { componentId: 'admin', file: 'admin/new/compose.yml' };
		const install = { componentId: 'api', file: 'api/new/compose.yml' };
		const unchanged = { componentId: 'agent', file: 'agent/installed/compose.yml' };
		expect(runtimeRepairTargets([upgrade, install, unchanged], new Set(['admin', 'api']), new Set())).toEqual([unchanged]);
	});
	it('preserves strict probes for unchanged releases and excludes held development targets', () => {
		const targets = [{ componentId: 'api' }, { componentId: 'agent' }, { componentId: 'lab' }];
		expect(runtimeRepairTargets(targets, new Set(), new Set(['agent']))).toEqual([targets[0], targets[2]]);
		expect(runtimeRepairTargets(targets, new Set(), new Set())).toEqual(targets);
	});
});

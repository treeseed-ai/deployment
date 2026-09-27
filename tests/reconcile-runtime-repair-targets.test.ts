import { describe, expect, it } from 'vitest';
import { runtimeActivationTargets, runtimeRepairTargets } from '../src/manager/reconcile.js';

it('defers probes until changed credential bindings are configured and activated', () => {
	expect(runtimeRepairTargets([{ componentId: 'api' }], new Set(), new Set(), true)).toEqual([]);
});

it('never activates an older released writer held by development during configuration start', () => {
	const ordered = [{ componentId: 'postgres' }, { componentId: 'identity' }, { componentId: 'api' }, { componentId: 'agent' }];
	const held = new Set(['api', 'agent']);
	const selected = runtimeActivationTargets(ordered, held, new Set<string>(), () => true);
	expect(selected.map(({ componentId }) => componentId)).toEqual(['postgres', 'identity']);
	// The same exclusion applies when restoring the accepted composition after a failed start.
	expect(runtimeActivationTargets(ordered, held, new Set<string>(), () => true)).toEqual(selected);
	expect(runtimeActivationTargets(ordered, new Set<string>(), new Set<string>(), () => true)).toEqual(ordered);
});

it('keeps ordinary component activation tied to changed targets and configuration impact', () => {
	const ordered = [{ componentId: 'postgres' }, { componentId: 'api' }, { componentId: 'agent' }];
	expect(runtimeActivationTargets(ordered, new Set(['api']), new Set(['agent']), id => id === 'postgres'))
		.toEqual([ordered[0], ordered[2]]);
});

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

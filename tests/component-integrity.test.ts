import { describe, expect, it } from 'vitest';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { verifiedComponentRelease } from '../src/catalog/component-integrity.js';
import { createPlan } from '../src/manager/plan.js';
import { catalogs, component, host } from './fixtures.js';

describe('immutable component runtime integrity', () => {
  it('accepts canonical serialization and rejects content changed after hashing', () => {
    const release = component('api', 'stable', 'b');
    release.runtimeDigest = deploymentDigest(release.runtime);
    expect(verifiedComponentRelease(JSON.parse(JSON.stringify(release)))).toEqual(release);
    release.runtime.services[0]!.composeService = 'changed';
    expect(() => verifiedComponentRelease(release)).toThrow('runtime digest mismatch');
  });

  it('rejects a producer digest calculated before default materialization', () => {
    const release = component('lab', 'stable', 'b');
    const { configuration: _configuration, ...raw } = release.runtime;
    expect(() => verifiedComponentRelease({ ...release, runtime: raw, runtimeDigest: deploymentDigest(raw) }))
      .toThrow('runtime digest mismatch');
  });

  it('reports an actionable plan blocker before quiescing any service', () => {
    const { stable, development } = catalogs();
    for (const release of [...stable.components, ...development.components]) release.runtimeDigest = deploymentDigest(release.runtime);
    expect(createPlan(host(), stable, development).plan.blockers).not.toContainEqual(expect.objectContaining({ code: 'component-runtime-digest-mismatch' }));
    development.components[0]!.runtime.services[0]!.composeService = 'changed';
    expect(createPlan(host(), stable, development).plan.blockers).toContainEqual(expect.objectContaining({
      code: 'component-runtime-digest-mismatch', message: expect.stringContaining('agent@'),
    }));
  });
});

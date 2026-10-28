import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { ComposeDeploymentHost } from '../../src/diagnose.js';
import { ServiceWorkerBuild } from '../../src/service-worker-build.js';
import { ServiceReleaseFixture } from '../support/release-fixture.js';
import { WorkerHandoffScenario } from '../support/worker-handoff.js';
class WorkerHandoffRegression {
  async run(): Promise<void> {
    const fixture = new ServiceReleaseFixture();
    try {
      await fixture.services();
      const directory = join(fixture.root, 'compiled-worker');
      mkdirSync(directory, { mode: 0o700 });
      const worker = ServiceWorkerBuild.produce(directory);
      copyFileSync(join(directory, worker.path), join(fixture.bundle, 'host-worker'));
      fixture.release.composition.worker = { ...worker, path: 'host-worker' };
      fixture.refreshService();
      const plan = await new ComposeDeploymentHost().plan(fixture.configuration);
      assert.equal(plan.formatVersion, 3);
      if (plan.formatVersion !== 3) throw new Error('Expected service plan');
      await new WorkerHandoffScenario(plan, fixture.root).run();
    } finally { fixture.close(); }
  }
}
const suite = new WorkerHandoffRegression();
test('regression: standalone worker defers mutable journal inspection until process-bound handoff', suite.run.bind(suite), 90000);

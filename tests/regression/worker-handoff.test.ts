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
      await this.prepare(fixture);
      const plan = await new ComposeDeploymentHost().plan(fixture.configuration);
      assert.equal(plan.formatVersion, 3);
      if (plan.formatVersion !== 3) throw new Error('Expected service plan');
      await new WorkerHandoffScenario(plan, fixture.root).run();
    } finally { fixture.close(); }
  }
  private async prepare(fixture: ServiceReleaseFixture): Promise<void> {
    await fixture.services();
    this.publication(fixture);
    const directory = join(fixture.root, 'compiled-worker');
    mkdirSync(directory, { mode: 0o700 });
    const worker = ServiceWorkerBuild.produce(directory);
    copyFileSync(join(directory, worker.path), join(fixture.bundle, 'host-worker'));
    fixture.release.composition.worker = { ...worker, path: 'host-worker' };
    fixture.refreshService();
  }
  private publication(fixture: ServiceReleaseFixture): void {
    const port = 50000 + parseInt(ServiceReleaseFixture.sha(fixture.root).slice(0, 4), 16) % 10000;
    fixture.configuration.origin = 'https://localhost:' + port;
    fixture.release.composition.services[0]!.definition.ports[0]!.publication!.port = port;
    fixture.recipe.services['instance-0']!.ports![0]!.published = port;
  }
}
const suite = new WorkerHandoffRegression();
test('regression: standalone worker defers mutable journal inspection until process-bound handoff', suite.run.bind(suite), 90000);

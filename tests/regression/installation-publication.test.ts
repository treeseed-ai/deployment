import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { InstallationStore, ServicePlanStore } from '@treeseed-cordis/deployment';
import { InstallationRecordFixture } from '../support/installation-records-program.js';
class CapturedPublication {
  private readonly original = InstallationStore.publish;
  write(directory: ReturnType<ServicePlanStore['directory']>): void {
    this.original(directory, 'captured.json', { value: 'preserved' });
    assert.deepEqual(
      JSON.parse(directory.file('captured.json', undefined, 4096, true).toString()),
      { value: 'preserved' },
    );
  }
}
class InstallationPublicationRegression {
  async run(): Promise<void> {
    const fixture = new InstallationRecordFixture();
    try {
      await fixture.prepare();
      const writer = await fixture.type().acquire(fixture.scope, fixture.signal);
      writer.close();
      const directory = new ServicePlanStore(fixture.release.installation).directory('artifacts');
      try {
        new CapturedPublication().write(directory);
      } finally {
        directory.close();
      }
    } finally {
      fixture.close();
    }
  }
}
const suite = new InstallationPublicationRegression();
test(
  'regression: a captured public publisher retains byte/mode semantics under a delegating receiver',
  suite.run.bind(suite),
  15000,
);

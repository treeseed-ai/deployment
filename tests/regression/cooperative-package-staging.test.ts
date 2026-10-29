import { test } from 'bun:test';
import { CooperativePackageFixture } from '../support/cooperative-package-program.js';
class BulkPublicationRegression {
  async progress(): Promise<void> {
    const fixture = new CooperativePackageFixture();
    try {
      await fixture.materialize();
      fixture.verify();
    } finally {
      fixture.close();
    }
  }
}
const suite = new BulkPublicationRegression();
test(
  'regression: bulk package publication cannot starve queued worker observations',
  suite.progress.bind(suite),
  15000,
);

import { test } from 'bun:test';
import { ParallelPackageFixture } from '../support/parallel-package-program.js';
class SerialPublicationRegression {
  async run(): Promise<void> {
    const fixture = new ParallelPackageFixture();
    try {
      await fixture.run();
      fixture.verified();
    } finally {
      fixture.close();
    }
  }
}
const suite = new SerialPublicationRegression();
test(
  'regression: durable package member I/O overlaps instead of serially blocking the runtime closure',
  suite.run.bind(suite),
  15000,
);

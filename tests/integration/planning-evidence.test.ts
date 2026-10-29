import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { ComposeDeploymentHost, type DiagnosticCommands } from '@treeseed-cordis/deployment';
import { PlanningBlockedError } from '@treeseed-cordis/sdk';
import { ServiceReleaseFixture } from '../support/release-fixture.js';
class UnavailableCommandFixture implements DiagnosticCommands {
  execute(): string | null {
    return null;
  }
}
class PlanningEvidenceIntegration {
  async custom(): Promise<void> {
    const fixture = new ServiceReleaseFixture();
    try {
      await fixture.services();
      try {
        await new ComposeDeploymentHost(new UnavailableCommandFixture()).plan(
          fixture.configuration,
        );
      } catch (error) {
        assert(error instanceof PlanningBlockedError);
        assert.equal(error.blockers[0]!.code, 'DOCKER_UNAVAILABLE');
        assert.equal(Object.getOwnPropertyDescriptor(error, 'cause'), undefined);
        return;
      }
      throw new Error('Unavailable custom adapter unexpectedly planned');
    } finally {
      fixture.close();
    }
  }
}
const suite = new PlanningEvidenceIntegration();
test(
  'integration: custom diagnostic adapters preserve typed planning blockers without fabricated native evidence',
  suite.custom.bind(suite),
);

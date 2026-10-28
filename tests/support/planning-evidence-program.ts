import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { ComposeDeploymentHost } from '@treeseed-cordis/deployment';
import { PlanningBlockedError } from '@treeseed-cordis/sdk';
import { ServiceReleaseFixture } from './release-fixture.js';
class PlanningEvidenceProgram {
  async run(): Promise<void> {
    if (process.argv[2] === '--formatter') return this.formatter();
    const fixture = new ServiceReleaseFixture();
    try {
      await fixture.services();
      fixture.configuration.engineContext = 'cordis-fixture-missing-' + randomUUID();
      const error = await this.blocked(fixture);
      this.proof(error, fixture.configuration.engineContext);
      assert.equal(existsSync(fixture.configuration.installationDirectory), false);
      process.stdout.write('planning-evidence-ok\n');
    } finally {
      fixture.close();
    }
  }
  private async blocked(fixture: ServiceReleaseFixture): Promise<PlanningBlockedError> {
    try {
      await new ComposeDeploymentHost().plan(fixture.configuration);
    } catch (error) {
      assert(error instanceof PlanningBlockedError);
      assert.deepEqual(error.blockers, [
        {
          code: 'DOCKER_UNAVAILABLE',
          message: 'Planning validation failed: DOCKER_UNAVAILABLE. No activation was performed.',
        },
      ]);
      return error;
    }
    throw new Error('Missing context unexpectedly planned');
  }
  private proof(error: PlanningBlockedError, context: string): void {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'cause');
    assert(
      descriptor,
      'exact failed native invocation must remain available on the original error',
    );
    assert.equal(descriptor.enumerable, false);
    assert.equal(descriptor.writable, false);
    const record = descriptor.value;
    assert.equal(record.category, 'context');
    assert.equal(record.kind, 'nonzero-exit');
    assert.equal(Object.isFrozen(record), true);
    assert(!JSON.stringify(record).includes(context));
    assert(!JSON.stringify(error).includes('cause'));
  }
  private async formatter(): Promise<void> {
    const source = await import('./npm-source-program.js');
    const Program = Reflect.get(source, 'NpmSourceProgram');
    assert.equal(typeof Program, 'function', 'source fixture must be safely importable');
    const error = new PlanningBlockedError([
      { code: 'DOCKER_UNAVAILABLE', message: 'BLOCKER_MESSAGE_CANARY' },
    ]);
    error.cause = { category: 'engine', kind: 'timeout', private: 'CAUSE_OUTPUT_CANARY' };
    try {
      Program.failed(error);
    } catch (failure) {
      assert(failure instanceof Error);
      assert(failure.message.includes('docker-invocation(engine:timeout)'));
      assert(!failure.message.includes('CANARY'));
      assert.equal(failure.cause, undefined);
      process.stdout.write('source-formatter-ok\n');
      return;
    }
    throw new Error('Expected fixture failure was accepted');
  }
}
if (import.meta.main) await new PlanningEvidenceProgram().run();

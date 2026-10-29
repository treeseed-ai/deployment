import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CapacitySchemas } from '@treeseed-cordis/sdk';
import { KataRunnerSession } from '../../src/kata-runner.js';
/** Process protocol fixtures only: actual Kata/Agent construction is a separate acceptance gate. */
class KataRunnerTransportTests {
  private readonly scope = CapacitySchemas.scope.parse({
    installationId: 'fixture.capacity',
    installationDirectory: '/fixture/capacity',
    capacityProviderId: 'fixture.provider',
    project: 'fixture.project',
    platformProfile: 'fixture.default',
    workerId: 'fixture.worker',
  });
  private child(mode: string) {
    return spawn('node', ['dist/tests/support/kata-runner-program.js', '--io-fixture', mode], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  async stable(): Promise<void> {
    const child = this.child('normal');
    const session = new KataRunnerSession(child, this.scope);
    try {
      const first = await session.readiness(new AbortController().signal);
      const second = await session.readiness(new AbortController().signal);
      assert.deepEqual(first.generation, second.generation);
      await session.close();
    } finally {
      child.kill('SIGKILL');
    }
  }
  async invalid(mode: string): Promise<void> {
    const child = this.child(mode);
    const session = new KataRunnerSession(child, this.scope);
    try {
      if (mode === 'generation') await session.readiness(new AbortController().signal);
      await assert.rejects(session.readiness(new AbortController().signal), this.safe.bind(this));
      await assert.rejects(session.close(), this.safe.bind(this));
    } finally {
      child.kill('SIGKILL');
    }
  }
  async cancelled(): Promise<void> {
    const child = this.child('silent');
    const session = new KataRunnerSession(child, this.scope);
    const controller = new AbortController();
    try {
      const request = session.readiness(controller.signal);
      controller.abort();
      await assert.rejects(request, this.safe.bind(this));
      await assert.rejects(session.close(), this.safe.bind(this));
    } finally {
      child.kill('SIGKILL');
    }
  }
  private safe(error: unknown): boolean {
    assert(error instanceof Error);
    assert.match(error.message, /^KATA_RUNNER_[A-Z_]+$/);
    assert(!error.message.includes('private-canary'));
    return true;
  }
}
const suite = new KataRunnerTransportTests();
test(
  'integration: bounded runner process transport freshly validates stable readiness and orderly disposal',
  suite.stable.bind(suite),
);
for (const mode of ['foreign', 'malformed', 'stderr', 'generation', 'exit'])
  test(
    'integration: bounded runner transport rejects ' + mode + ' without reporting clean disposal',
    suite.invalid.bind(suite, mode),
  );
test(
  'integration: cancelled runner exchange remains fenced through disposal',
  suite.cancelled.bind(suite),
);

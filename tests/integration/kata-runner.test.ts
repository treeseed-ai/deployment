import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, chmodSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { GuestRuntimeArchive } from '@treeseed-cordis/deployment/sandbox';
import { KataCommand } from '../../src/kata-command.js';
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
for (const mode of ['foreign', 'malformed', 'stderr', 'generation', 'exit', 'duplicate', 'silent'])
  test(
    'integration: bounded runner transport rejects ' + mode + ' without reporting clean disposal',
    suite.invalid.bind(suite, mode),
    20000,
  );
test(
  'integration: cancelled runner exchange remains fenced through disposal',
  suite.cancelled.bind(suite),
);

/** Genuine executable bytes are inert stdin data in this host-only pipe control. */
class KataRunnerPayloadTests {
  private readonly directory = mkdtempSync(join(tmpdir(), 'runner-pipe-'));
  private artifact() {
    copyFileSync('vendor/agent-guest.tgz', join(this.directory, 'agent.tgz'));
    chmodSync(join(this.directory, 'agent.tgz'), 0o600);
    return new GuestRuntimeArchive({
      directory: this.directory,
      archive: {
        path: 'agent.tgz',
        sha256: '3ebf0257ae72ce921672d016e5bc7530515069a2994ce77660f2c27751f8b0aa',
        size: statSync('vendor/agent-guest.tgz').size,
      },
      package: { name: '@treeseed-cordis/agent', version: '0.0.0-cordis.22' },
    });
  }
  private receiver(): { executable: string; arguments: string[] } {
    const program = resolve('dist/tests/support/kata-runner-program.js');
    const located = spawnSync('node', [program, '--node-path'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(located.status, 0, located.stderr);
    return { executable: located.stdout, arguments: [program, '--stdin-fixture'] };
  }
  async transfer(): Promise<void> {
    const signal = new AbortController().signal;
    try {
      const artifact = await this.artifact().read(signal);
      const receiver = this.receiver();
      const output = await new KataCommand(receiver.executable, receiver.arguments, signal, {
        stdin: artifact.executable,
        deadlineMs: 30000,
        outputLimitBytes: 1024,
      }).run();
      assert.deepEqual(JSON.parse(output.toString()), {
        size: artifact.manifest.executable.size,
        sha256: artifact.manifest.executable.sha256,
      });
    } finally {
      rmSync(this.directory, { recursive: true });
    }
  }
}

class KataCommandDeadlineTests {
  async expired(): Promise<void> {
    const options = { deadlineMs: 10000, deadline: performance.now() - 1 };
    const command = new KataCommand(
      '/fixture/must-not-start',
      [],
      new AbortController().signal,
      options,
    );
    await assert.rejects(command.run(), { code: 'KATA_COMMAND_TIMEOUT' });
  }
  async shared(): Promise<void> {
    const located = spawnSync(
      'node',
      ['dist/tests/support/kata-runner-program.js', '--node-path'],
      {
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    assert.equal(located.status, 0, located.stderr);
    const options = { deadlineMs: 10000, deadline: performance.now() + 250 };
    const command = new KataCommand(
      located.stdout,
      [resolve('dist/tests/support/kata-runner-program.js'), '--wait-fixture'],
      new AbortController().signal,
      options,
    );
    await assert.rejects(command.run(), { code: 'KATA_COMMAND_TIMEOUT' });
  }
}
const deadlines = new KataCommandDeadlineTests();
test(
  'integration: expired shared command budget refuses spawn before any executable runs',
  deadlines.expired.bind(deadlines),
);
test(
  'integration: actual child obeys shared absolute deadline before its local timeout',
  deadlines.shared.bind(deadlines),
  5000,
);
const payload = new KataRunnerPayloadTests();
test(
  'integration: actual runner bytes cross the bounded host process pipe without execution or truncation',
  payload.transfer.bind(payload),
  40000,
);

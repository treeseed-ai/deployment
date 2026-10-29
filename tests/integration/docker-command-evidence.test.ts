import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DockerCommands } from '../../src/docker-commands.js';
import { DockerEvidenceFixture as Fixture } from '../support/docker-evidence-program.js';
class DockerCommandEvidenceIntegration {
  context(): void {
    const commands = new DockerCommands();
    Fixture.absent(commands);
    const before = Fixture.read(commands)!;
    commands.execute(['context', 'inspect', 'cordis-fixture-missing-' + crypto.randomUUID()]);
    assert.equal(Fixture.read(commands)!.category, 'context');
    assert.notEqual(Fixture.read(commands), before);
    assert.equal(typeof commands.execute(['--version']), 'string');
    assert.equal(Fixture.read(commands), null);
  }
  timeout(): void {
    const record = this.command('--fixture-timeout');
    assert.equal(record.kind, 'timeout');
    assert.equal(record.category, 'other');
    assert(record.elapsedMs >= 4500 && record.elapsedMs < 10000);
    assert.equal(record.status, null);
  }
  output(): void {
    const record = this.command('--fixture-output');
    assert.equal(record.kind, 'output-limit');
    assert(!JSON.stringify(record).includes('output-must-not-appear-canary'));
    assert(record.elapsedMs >= 0 && record.elapsedMs < 10000);
  }
  private command(mode: string): NonNullable<ReturnType<typeof Fixture.read>> {
    const directory = mkdtempSync(join(tmpdir(), 'command-evidence-'));
    const original = process.env.PATH;
    try {
      const executable = Bun.which('node');
      assert(executable, 'qualified Node fixture runtime is required');
      symlinkSync(realpathSync(executable), join(directory, 'docker'));
      process.env.PATH = directory;
      const commands = new DockerCommands();
      const program = resolve('dist/tests/support/docker-evidence-program.js');
      assert.equal(commands.execute([program, mode]), null);
      return Fixture.read(commands)!;
    } finally {
      if (original === undefined) delete process.env.PATH;
      else process.env.PATH = original;
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
const suite = new DockerCommandEvidenceIntegration();
test(
  'integration: real Docker invocation evidence replaces prior failures and clears after success',
  suite.context.bind(suite),
);
test(
  'integration: default command adapter distinguishes real process timeout without changing its deadline',
  suite.timeout.bind(suite),
  15000,
);
test(
  'integration: default command adapter distinguishes bounded output without retaining raw bytes',
  suite.output.bind(suite),
  15000,
);

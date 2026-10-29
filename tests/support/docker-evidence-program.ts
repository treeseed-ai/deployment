import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DockerCommands } from '@treeseed-cordis/deployment';
interface SafeCommandFailure {
  category: string;
  kind: string;
  elapsedMs: number;
  status: number | null;
  signal: string | null;
}
export class DockerEvidenceFixture {
  static explain(error: unknown, commands: DockerCommands): never {
    const failure = this.read(commands);
    if (failure)
      throw new Error('DOCKER_PREREQUISITE ' + JSON.stringify(failure), { cause: error });
    throw error;
  }
  static read(commands: DockerCommands): SafeCommandFailure | null {
    const value: unknown = Reflect.get(commands, 'failure');
    assert.notEqual(
      value,
      undefined,
      'default Docker adapter must retain safe failed invocation evidence',
    );
    return value as SafeCommandFailure | null;
  }
  static absent(commands: DockerCommands): void {
    const context = 'cordis-fixture-missing-' + randomUUID();
    assert.equal(commands.execute(['--context', context, 'info', '--format', '{{json .}}']), null);
    const record = this.read(commands)!;
    assert.equal(record.category, 'engine');
    assert.equal(record.kind, 'nonzero-exit');
    assert.equal(Object.isFrozen(record), true);
    assert(record.elapsedMs >= 0 && Number.isInteger(record.elapsedMs));
    assert(record.status !== null && record.status > 0 && record.status <= 255);
    assert.equal(record.signal, null);
    assert(!JSON.stringify(record).includes(context));
    assert.deepEqual(Object.keys(record).sort(), [
      'category',
      'elapsedMs',
      'kind',
      'signal',
      'status',
    ]);
  }
}
class DockerEvidenceProgram {
  run(): void {
    if (process.argv[2] === '--fixture-timeout') return this.wait();
    if (process.argv[2] === '--fixture-output') return this.output();
    const commands = new DockerCommands();
    assert.equal(DockerEvidenceFixture.read(commands), null);
    DockerEvidenceFixture.absent(commands);
    assert.equal(typeof commands.execute(['--version']), 'string');
    assert.equal(DockerEvidenceFixture.read(commands), null);
    process.stdout.write('docker-command-evidence-ok\n');
  }
  private wait(): void {
    setTimeout(DockerEvidenceProgram.finished, 10000);
  }
  private output(): void {
    process.stdout.write('output-must-not-appear-canary'.repeat(131072));
  }
  private static finished(): void {
    process.exit(0);
  }
}
if (import.meta.main) new DockerEvidenceProgram().run();

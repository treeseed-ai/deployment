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
    const commands = new DockerCommands();
    assert.equal(DockerEvidenceFixture.read(commands), null);
    DockerEvidenceFixture.absent(commands);
    assert.equal(typeof commands.execute(['--version']), 'string');
    assert.equal(DockerEvidenceFixture.read(commands), null);
    process.stdout.write('docker-command-evidence-ok\n');
  }
}
if (import.meta.main) new DockerEvidenceProgram().run();

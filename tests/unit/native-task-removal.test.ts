import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { KataSandboxError } from '../../src/kata-command.js';

class RemovalCommandFixture {
  static readonly name = 'cordis-sandbox-' + 'a'.repeat(24) + '-' + 'b'.repeat(24);
  readonly calls: string[][] = [];
  inspections = 0;
  present = true;
  failure: Error | null = null;
  cancelAfterStop: AbortController | null = null;
  async list(_kind: 'tasks', _signal: AbortSignal): Promise<string[]> {
    this.inspections++;
    return this.present ? [RemovalCommandFixture.name] : [];
  }
  async text(args: string[], _signal: AbortSignal): Promise<string> {
    this.calls.push([...args]);
    if (this.failure) throw this.failure;
    if (args[0] === 'tasks') this.cancelAfterStop?.abort();
    return '';
  }
}
class NativeTaskRemovalUnit {
  private async removal(
    client: RemovalCommandFixture,
  ): Promise<{ remove(name: string, signal: AbortSignal): Promise<void> }> {
    const module = await import('../../src/native-task-removal.js');
    return new module.NativeTaskRemoval(client);
  }
  async absent(): Promise<void> {
    const client = new RemovalCommandFixture();
    client.present = false;
    await (
      await this.removal(client)
    ).remove(RemovalCommandFixture.name, new AbortController().signal);
    assert.deepEqual(client.calls, [['containers', 'delete', RemovalCommandFixture.name]]);
  }
  async foreign(name: unknown): Promise<void> {
    const client = new RemovalCommandFixture();
    const removal = await this.removal(client);
    await assert.rejects(
      removal.remove.bind(removal, name as string, new AbortController().signal),
      {
        message: 'KATA_FOREIGN_RESOURCE',
      },
    );
    assert.equal(client.inspections, 0);
    assert.deepEqual(client.calls, []);
  }
  async cancelled(): Promise<void> {
    const client = new RemovalCommandFixture();
    const removal = await this.removal(client);
    await assert.rejects(
      removal.remove.bind(removal, RemovalCommandFixture.name, AbortSignal.abort()),
      {
        message: 'KATA_CANCELLED',
      },
    );
    assert.equal(client.inspections, 0);
    assert.deepEqual(client.calls, []);
  }
  async cancelledAfterStop(): Promise<void> {
    const client = new RemovalCommandFixture();
    client.cancelAfterStop = new AbortController();
    const removal = await this.removal(client);
    await assert.rejects(
      removal.remove.bind(removal, RemovalCommandFixture.name, client.cancelAfterStop.signal),
      {
        message: 'KATA_CANCELLED',
      },
    );
    assert.deepEqual(client.calls, [['tasks', 'delete', '--force', RemovalCommandFixture.name]]);
  }
  async failedContainer(): Promise<void> {
    const client = new RemovalCommandFixture();
    client.present = false;
    client.failure = new KataSandboxError('KATA_COMMAND_TIMEOUT');
    const removal = await this.removal(client);
    await assert.rejects(
      removal.remove.bind(removal, RemovalCommandFixture.name, new AbortController().signal),
      {
        message: 'KATA_COMMAND_TIMEOUT',
        code: 'KATA_COMMAND_TIMEOUT',
        operation: 'container-delete',
      },
    );
    assert.deepEqual(client.calls, [['containers', 'delete', RemovalCommandFixture.name]]);
  }
}
const suite = new NativeTaskRemovalUnit();
test(
  'unit: native removal skips absent task and preserves container cleanup',
  suite.absent.bind(suite),
);
test('unit: native removal cancellation precedes every effect', suite.cancelled.bind(suite));
test(
  'unit: native removal cancellation after stop prevents container deletion',
  suite.cancelledAfterStop.bind(suite),
);
test(
  'unit: native removal preserves safe command codes and fixed operation context',
  suite.failedContainer.bind(suite),
);
for (const name of [
  null,
  '',
  'PRIVATE_FOREIGN',
  RemovalCommandFixture.name + '/escape',
  RemovalCommandFixture.name.toUpperCase(),
])
  test(
    'unit: native removal rejects foreign resource ' + JSON.stringify(name),
    suite.foreign.bind(suite, name),
  );

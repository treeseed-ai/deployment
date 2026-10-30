import assert from 'node:assert/strict';
import { test } from 'bun:test';

/** Models the documented failed standalone-kill boundary; no daemon or VM is constructed. */
class TaskExitRaceClient {
  static readonly name = 'cordis-sandbox-' + 'a'.repeat(24) + '-' + 'b'.repeat(24);
  readonly calls: string[][] = [];
  failStop = false;
  async list(kind: 'tasks', signal: AbortSignal): Promise<string[]> {
    assert.equal(kind, 'tasks');
    assert(!signal.aborted);
    return [TaskExitRaceClient.name];
  }
  async text(args: string[], signal: AbortSignal): Promise<string> {
    assert(!signal.aborted);
    this.calls.push([...args]);
    if (args[1] === 'kill') throw new Error('KILL_CAN_REPORT_NOT_FOUND_AFTER_SUCCESS');
    if (args[0] === 'tasks') {
      assert.deepEqual(args, ['tasks', 'delete', '--force', TaskExitRaceClient.name]);
      if (this.failStop) throw new Error('PRIVATE_STOP_FAILURE');
    } else assert.deepEqual(args, ['containers', 'delete', TaskExitRaceClient.name]);
    return '';
  }
}
class NativeTaskRemovalRegression {
  private async removal(
    client: TaskExitRaceClient,
  ): Promise<{ remove(name: string, signal: AbortSignal): Promise<void> }> {
    const module = await import('../../src/native-task-removal.js');
    return new module.NativeTaskRemoval(client);
  }
  async exitRace(): Promise<void> {
    const client = new TaskExitRaceClient();
    await (
      await this.removal(client)
    ).remove(TaskExitRaceClient.name, new AbortController().signal);
    assert.deepEqual(client.calls, [
      ['tasks', 'delete', '--force', TaskExitRaceClient.name],
      ['containers', 'delete', TaskExitRaceClient.name],
    ]);
  }
  async failedStop(): Promise<void> {
    const client = new TaskExitRaceClient();
    client.failStop = true;
    const removal = await this.removal(client);
    await assert.rejects(
      removal.remove.bind(removal, TaskExitRaceClient.name, new AbortController().signal),
      {
        message: 'KATA_CLEANUP_FAILED',
        operation: 'task-delete',
      },
    );
    assert.deepEqual(client.calls, [['tasks', 'delete', '--force', TaskExitRaceClient.name]]);
  }
}
const suite = new NativeTaskRemovalRegression();
test(
  'regression: native cleanup uses the upstream wait-and-delete boundary after exit races',
  suite.exitRace.bind(suite),
);
test(
  'regression: failed native stop never proceeds to container deletion',
  suite.failedStop.bind(suite),
);

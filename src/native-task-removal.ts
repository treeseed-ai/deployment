import { KataSandboxError } from './kata-command.js';

interface RemovalClient {
  list(kind: 'tasks', signal: AbortSignal): Promise<string[]>;
  text(args: string[], signal: AbortSignal): Promise<string>;
}
type RemovalOperation = 'task-delete' | 'container-delete';
/** Fixed operation metadata never carries raw command arguments or nested causes. */
class NativeTaskRemovalError extends KataSandboxError {
  constructor(
    code: string,
    readonly operation: RemovalOperation,
  ) {
    super(code);
  }
}
/** Internal coherent cleanup; the selected host retains ownership and final physical read-back. */
export class NativeTaskRemoval {
  constructor(private readonly client: RemovalClient) {}
  async remove(name: string, signal: AbortSignal): Promise<void> {
    this.admit(name, signal);
    if ((await this.client.list('tasks', signal)).includes(name))
      await this.execute('task-delete', ['tasks', 'delete', '--force', name], signal);
    await this.execute('container-delete', ['containers', 'delete', name], signal);
  }
  private admit(name: string, signal: AbortSignal): void {
    KataSandboxError.require(
      typeof name === 'string' && /^cordis-sandbox-[a-f0-9]{24}-[a-f0-9]{24}$/.test(name),
      'KATA_FOREIGN_RESOURCE',
    );
    KataSandboxError.require(!signal.aborted, 'KATA_CANCELLED');
  }
  private async execute(
    operation: RemovalOperation,
    args: string[],
    signal: AbortSignal,
  ): Promise<void> {
    this.admit(args[args.length - 1]!, signal);
    try {
      await this.client.text(args, signal);
    } catch (error) {
      const code = error instanceof KataSandboxError ? error.code : 'KATA_CLEANUP_FAILED';
      throw new NativeTaskRemovalError(code, operation);
    }
  }
}

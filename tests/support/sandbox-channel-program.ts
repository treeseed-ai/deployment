import assert from 'node:assert/strict';
class SandboxChannelProgram {
  async run(): Promise<void> {
    const module = await import('@treeseed-cordis/deployment/sandbox-control');
    assert.equal(typeof Reflect.get(module, 'SandboxControlApplication'), 'function');
    assert.equal(typeof Reflect.get(module, 'SandboxSocketClient'), 'function');
    const application = Reflect.get(module, 'SandboxControlApplication') as {
      start(input: unknown): Promise<unknown>;
    };
    await assert.rejects(application.start({}), { message: 'INVALID_SANDBOX_CONTROL_CONTRACT' });
    process.stdout.write('sandbox-channel-interface-ok\n');
  }
}
if (import.meta.main) await new SandboxChannelProgram().run();

import assert from 'node:assert/strict';
import * as Sandbox from '@treeseed-cordis/deployment/sandbox';
import { TASK_CONFIGURATION_INPUT } from './runtime-task-program.js';

export class NativePolicyInput {
  static component(role: string): { role: string; member: string; path: string } {
    return { role, member: 'opt/kata/' + role, path: '/opt/kata/' + role };
  }
  static selected() {
    return {
      ...TASK_CONFIGURATION_INPUT,
      resources: { vcpus: 2, memoryMiB: 1024, scratchMiB: 64 },
      runtime: {
        ...TASK_CONFIGURATION_INPUT.runtime,
        configurationMode: 'task-options',
        archive: { path: '/PRIVATE_ARCHIVE', size: 1, sha256: 'a'.repeat(64) },
        shim: { ...TASK_CONFIGURATION_INPUT.runtime.shim, path: '/opt/kata/shim' },
        hypervisor: {
          ...TASK_CONFIGURATION_INPUT.runtime.hypervisor,
          path: '/opt/kata/hypervisor',
        },
        policy: { components: structuredClone(COMPONENTS) },
      },
    };
  }
}
const COMPONENTS = ['configuration', 'hypervisor', 'kernel', 'rootfs', 'shim', 'virtiofs'].map(
  NativePolicyInput.component,
);
class NativePolicyProgram {
  static async run(): Promise<void> {
    const selected = NativePolicyInput.selected();
    const parsed = Sandbox.KataSandboxPlugin.Config.parse(selected);
    assert.deepEqual(Reflect.get(parsed.runtime, 'policy'), { components: COMPONENTS });
    await this.incomplete(selected);
    process.stdout.write('native-policy-interface-ok\n');
  }
  private static async incomplete(input: object): Promise<void> {
    const selected = input as { runtime: Record<string, unknown> };
    const runtime = { ...selected.runtime, archive: undefined };
    await assert.rejects(
      Sandbox.KataSandboxBackend.open.bind(Sandbox.KataSandboxBackend, { ...input, runtime }),
      { message: 'KATA_CONFIGURATION_INVALID' },
    );
  }
}
if (import.meta.main) await NativePolicyProgram.run();

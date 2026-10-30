import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { NativePolicyInput } from '../support/native-policy-program.js';
import { TASK_CONFIGURATION_INPUT } from '../support/runtime-task-program.js';

interface PolicySelection {
  assertConfiguration(input: unknown): void;
}
class NativePolicySelections {
  private async selection(): Promise<PolicySelection> {
    const module = await import('../../src/native-policy.js');
    const Type = Reflect.get(module, 'NativePolicyCustody');
    assert.equal(typeof Type?.assertConfiguration, 'function', 'Native policy admission missing');
    return Type as PolicySelection;
  }
  async compatible(): Promise<void> {
    const selection = await this.selection();
    selection.assertConfiguration(TASK_CONFIGURATION_INPUT);
    selection.assertConfiguration(NativePolicyInput.selected());
  }
  private changed(path: readonly string[], value: unknown): object {
    const input = NativePolicyInput.selected();
    let target: object = input;
    for (const segment of path.slice(0, -1)) target = Reflect.get(target, segment) as object;
    Reflect.set(target, path[path.length - 1]!, value);
    return input;
  }
  async refused(path: readonly string[], value: unknown): Promise<void> {
    const selection = await this.selection();
    const input = this.changed(path, value);
    assert.throws(selection.assertConfiguration.bind(selection, input), {
      message: 'KATA_CONFIGURATION_INVALID',
    });
  }
}
const suite = new NativePolicySelections();
test(
  'unit: native policy admission preserves compatible mode and complete explicit selection',
  suite.compatible.bind(suite),
);
for (const [path, value] of [
  [['runtime', 'configurationMode'], 'environment'],
  [['runtime', 'archive'], undefined],
  [['resources'], undefined],
  [['runtime', 'policy', 'components'], []],
  [['runtime', 'policy', 'components', '0', 'role'], 'hypervisor'],
  [['runtime', 'policy', 'components', '0', 'role'], 'unknown'],
  [['runtime', 'policy', 'components', '0', 'member'], 'opt/kata/hypervisor'],
  [['runtime', 'policy', 'components', '0', 'path'], '/opt/kata/hypervisor'],
  [['runtime', 'policy', 'components', '0', 'path'], '/opt/kata/../configuration'],
  [['runtime', 'shim', 'path'], '/PRIVATE_OTHER_SHIM'],
  [['runtime', 'hypervisor', 'path'], '/PRIVATE_OTHER_HYPERVISOR'],
] as const)
  test(
    'unit: native policy admission refuses incomplete or ambiguous selection ' +
      path.join('.') +
      ':' +
      value,
    suite.refused.bind(suite, path, value),
  );

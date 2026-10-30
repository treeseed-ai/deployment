import assert from 'node:assert/strict';
import { test } from 'bun:test';
interface Selection {
  arguments(): string[];
  assertEnvironment(values: readonly string[]): void;
  assertOptions(value: unknown): void;
}
const OPTION = { type_url: 'runtimeoptions.v1.Options', value: 'EhUvcHJpdmF0ZS9ydW50aW1lLnRvbWw=' };
class KataTaskSelectionCases {
  private async selector(
    mode: 'environment' | 'task-options',
    path = '/private/runtime.toml',
  ): Promise<Selection> {
    const modulePath = '../../src/kata-task-options.js';
    const module = await import(modulePath);
    const Type = Reflect.get(module, 'KataTaskOptions');
    assert.equal(typeof Type, 'function', 'Native task selection invariant missing');
    return new Type(mode, path);
  }
  async arguments(): Promise<void> {
    assert.deepEqual((await this.selector('environment')).arguments(), []);
    const selected = await this.selector('task-options', '/private/runtime = é.toml');
    assert.deepEqual(selected.arguments(), ['--runtime-config-path', '/private/runtime = é.toml']);
    selected.arguments().push('PRIVATE_ARGUMENT');
    assert.deepEqual(selected.arguments(), ['--runtime-config-path', '/private/runtime = é.toml']);
  }
  async environment(): Promise<void> {
    (await this.selector('environment')).assertEnvironment([
      'PATH=/bin',
      'KATA_CONF_FILE=/private/runtime.toml',
    ]);
    (await this.selector('task-options')).assertEnvironment([
      'PATH=/bin',
      'KATA_CONF_FILE_EXTRA=ignored',
    ]);
  }
  async refusedEnvironment(mode: 'environment' | 'task-options', values: string[]): Promise<void> {
    const selected = await this.selector(mode);
    assert.throws(selected.assertEnvironment.bind(selected, values), {
      message: 'KATA_RUNTIME_CONFIGURATION',
    });
  }
  async options(): Promise<void> {
    (await this.selector('task-options')).assertOptions(OPTION);
    const environment = await this.selector('environment');
    environment.assertOptions(null);
    environment.assertOptions(undefined);
    assert.throws(environment.assertOptions.bind(environment, OPTION), {
      message: 'KATA_RESOURCE_CHANGED',
    });
  }
  async refusedOptions(value: unknown): Promise<void> {
    const selected = await this.selector('task-options');
    assert.throws(selected.assertOptions.bind(selected, value), {
      message: 'KATA_RESOURCE_CHANGED',
    });
  }
  async unicode(): Promise<void> {
    const path = '/' + 'é'.repeat(80) + '.toml';
    const selected = await this.selector('task-options', path);
    const wire = Buffer.concat([Buffer.from([0x12, 0xa6, 0x01]), Buffer.from(path)]);
    selected.assertOptions({ type_url: OPTION.type_url, value: wire.toString('base64') });
    assert.equal(Buffer.byteLength(path), 166);
  }
}
const suite = new KataTaskSelectionCases();
test(
  'unit: native task selection emits only fixed arguments and preserves path data',
  suite.arguments.bind(suite),
);
test(
  'unit: native task selection accepts exact unmasked environment',
  suite.environment.bind(suite),
);
for (const [mode, values] of [
  ['environment', []],
  ['environment', ['KATA_CONF_FILE=/other']],
  ['environment', ['KATA_CONF_FILE=/private/runtime.toml', 'KATA_CONF_FILE=/private/runtime.toml']],
  ['task-options', ['KATA_CONF_FILE=']],
  ['task-options', ['KATA_CONF_FILE=/private/runtime.toml']],
  ['task-options', ['KATA_CONF_FILE=/other']],
] as const)
  test(
    'unit: native task selection refuses masked or missing environment ' +
      mode +
      JSON.stringify(values),
    suite.refusedEnvironment.bind(suite, mode, [...values]),
  );
test(
  'unit: native task selection binds exact configuration-only protobuf metadata',
  suite.options.bind(suite),
);
test(
  'unit: native task selection binds UTF8 paths across the protobuf length boundary',
  suite.unicode.bind(suite),
);
for (const value of [
  null,
  undefined,
  {},
  { type_url: 'other', value: OPTION.value },
  { typeUrl: OPTION.type_url, value: OPTION.value },
  { type_url: OPTION.type_url, value: '' },
  { ...OPTION, value: OPTION.value + '=' },
  { ...OPTION, value: 'EggvZm9yZWlnbg==' },
  {
    ...OPTION,
    value: Buffer.concat([Buffer.from(OPTION.value, 'base64'), Buffer.from([0x1a, 1, 1])]).toString(
      'base64',
    ),
  },
  { ...OPTION, extra: true },
])
  test(
    'unit: native task selection refuses foreign or malformed option metadata ' +
      JSON.stringify(value),
    suite.refusedOptions.bind(suite, value),
  );

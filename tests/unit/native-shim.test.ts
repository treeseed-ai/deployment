import assert from 'node:assert/strict';
import { test } from 'bun:test';
import * as Sandbox from '@treeseed-cordis/deployment/sandbox';

interface ShimProjection {
  parse(args: unknown, name: unknown): object;
}
class NativeShimCases {
  static readonly name = 'cordis-sandbox-' + 'a'.repeat(24) + '-' + 'b'.repeat(24);
  static readonly namespace = this.name.slice(0, -25);
  static readonly args = ['shim', '-id', this.name, '-namespace', this.namespace];
  private projection(): ShimProjection {
    const Type = Reflect.get(Sandbox, 'NativeShimProjection');
    assert.equal(typeof Type, 'function', 'Public native shim projection missing');
    return new Type() as ShimProjection;
  }
  accepted(args: readonly string[]): void {
    const result = this.projection().parse(args, NativeShimCases.name);
    assert.deepEqual(result, {
      sandboxName: NativeShimCases.name,
      namespace: NativeShimCases.namespace,
    });
    assert(Object.isFrozen(result));
  }
  rejected(args: unknown, name: unknown): void {
    const projection = this.projection();
    assert.throws(projection.parse.bind(projection, args, name), this.safe.bind(this));
  }
  private safe(error: unknown): boolean {
    assert(error instanceof Error);
    assert.equal(error.message, 'KATA_SHIM_ARGUMENTS_INVALID');
    assert.equal(Reflect.get(error, 'cause'), undefined);
    assert(!String(error).includes('PRIVATE_'));
    return true;
  }
}
const suite = new NativeShimCases();
for (const args of [
  NativeShimCases.args,
  [
    'shim',
    '-namespace',
    NativeShimCases.namespace,
    '-address',
    '/PRIVATE_SOCKET',
    '-id',
    NativeShimCases.name,
  ],
])
  test(
    'unit: native shim binds the exact owned sandbox and namespace ' + JSON.stringify(args),
    suite.accepted.bind(suite, args),
  );
for (const args of [
  null,
  [],
  ['shim'],
  ['shim', '-id', NativeShimCases.name],
  ['shim', '-namespace', NativeShimCases.namespace],
  ['shim', '-id', 'FOREIGN', '-namespace', NativeShimCases.namespace],
  ['shim', '-id', NativeShimCases.name, '-namespace', 'FOREIGN'],
  [...NativeShimCases.args, '-id', NativeShimCases.name],
  [...NativeShimCases.args, '-namespace', NativeShimCases.namespace],
  [...NativeShimCases.args, '--id', NativeShimCases.name],
  [...NativeShimCases.args, '--namespace', NativeShimCases.namespace],
  [...NativeShimCases.args, '-id=FOREIGN'],
  [...NativeShimCases.args, '-namespace=FOREIGN'],
  [...NativeShimCases.args, '--id=FOREIGN'],
  [...NativeShimCases.args, '--namespace=FOREIGN'],
  [...NativeShimCases.args, '--'],
  [...NativeShimCases.args, '/PRIVATE_ARGUMENT\0'],
  [...NativeShimCases.args, 1],
  [...NativeShimCases.args, 'a'.repeat(4097)],
  new Array(8193).fill('x'),
])
  test(
    'unit: native shim rejects unbound or ambiguous arguments ' +
      JSON.stringify(args).slice(0, 250),
    suite.rejected.bind(suite, args, NativeShimCases.name),
  );
for (const name of [
  null,
  '',
  'PRIVATE_NAME',
  'cordis-sandbox-' + 'A'.repeat(24) + '-' + 'b'.repeat(24),
])
  test(
    'unit: native shim rejects invalid owned names ' + JSON.stringify(name),
    suite.rejected.bind(suite, NativeShimCases.args, name),
  );

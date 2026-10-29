import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { SandboxControlError } from '@treeseed-cordis/sdk';
import { ControlGuard } from '../../src/sandbox-io.js';
class SandboxFailureProjectionTests {
  private reads = 0;
  recognized(): void {
    assert.equal(
      ControlGuard.failure(new SandboxControlError('SANDBOX_CANCELLED')),
      'SANDBOX_CANCELLED',
    );
    assert.equal(
      ControlGuard.failure(new Error('PRIVATE_PROVIDER_CANARY')),
      'SANDBOX_OPERATION_FAILED',
    );
    assert.equal(ControlGuard.failure({ code: 'SANDBOX_CANCELLED' }), 'SANDBOX_OPERATION_FAILED');
  }
  getter(): void {
    const error = new SandboxControlError('SANDBOX_CANCELLED');
    Object.defineProperty(error, 'code', { get: this.privateDetail.bind(this) });
    assert.equal(ControlGuard.failure(error), 'SANDBOX_OPERATION_FAILED');
    assert.equal(this.reads, 0);
  }
  inherited(): void {
    const prototype = Object.create(SandboxControlError.prototype) as Error;
    Object.defineProperty(prototype, 'code', { get: this.privateDetail.bind(this) });
    assert.equal(ControlGuard.failure(Object.create(prototype)), 'SANDBOX_OPERATION_FAILED');
    assert.equal(this.reads, 0);
  }
  proxy(): void {
    for (const handler of [
      { getPrototypeOf: this.privateDetail.bind(this) },
      { getOwnPropertyDescriptor: this.privateDetail.bind(this) },
    ]) {
      const error = new Proxy(new SandboxControlError('SANDBOX_CANCELLED'), handler);
      assert.equal(ControlGuard.failure(error), 'SANDBOX_OPERATION_FAILED');
    }
  }
  private privateDetail(): never {
    this.reads++;
    throw new Error('PRIVATE_PROVIDER_CANARY');
  }
}
const suite = new SandboxFailureProjectionTests();
test(
  'unit: sandbox failure projection preserves only recognized own SDK codes',
  suite.recognized.bind(suite),
);
test(
  'unit: sandbox failure projection never reads an own provider code getter',
  suite.getter.bind(suite),
);
test(
  'unit: sandbox failure projection never reads an inherited provider code getter',
  suite.inherited.bind(suite),
);
test(
  'unit: sandbox failure projection contains hostile prototype and descriptor inspection',
  suite.proxy.bind(suite),
);

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { PlanningBlockedError } from '@treeseed-cordis/sdk';
import { NpmSourceProgram } from '../support/npm-source-program.js';
class CauseGetterCanary {
  called = false;
  descriptor(): PropertyDescriptor | undefined {
    this.called = true;
    throw new Error('PROXY_OUTPUT_CANARY');
  }
  read(): string {
    this.called = true;
    return 'GETTER_OUTPUT_CANARY';
  }
}
class PlanningEvidenceUnit {
  known(): void {
    const value = this.message({
      category: 'engine',
      kind: 'timeout',
      private: 'CAUSE_OUTPUT_CANARY',
    });
    assert(value.includes('docker-invocation(engine:timeout)'));
    assert(!value.includes('CANARY'));
  }
  unknown(): void {
    for (const cause of [
      null,
      'CAUSE_CANARY',
      { category: 'CAUSE_CANARY', kind: 'timeout' },
      { category: 'engine', kind: 'CAUSE_CANARY' },
    ]) {
      const value = this.message(cause);
      assert(value.includes('docker-invocation(unavailable)'));
      assert(!value.includes('CANARY'));
    }
  }
  getters(): void {
    const canary = new CauseGetterCanary();
    const cause = { kind: 'timeout' };
    Object.defineProperty(cause, 'category', { get: canary.read.bind(canary) });
    assert(this.message(cause).includes('docker-invocation(unavailable)'));
    const error = new PlanningBlockedError([
      { code: 'DOCKER_UNAVAILABLE', message: 'BLOCKER_CANARY' },
    ]);
    Object.defineProperty(error, 'cause', { get: canary.read.bind(canary) });
    assert(this.render(error).includes('docker-invocation(unavailable)'));
    assert.equal(canary.called, false);
  }
  proxies(): void {
    const canary = new CauseGetterCanary();
    const cause = new Proxy({}, { getOwnPropertyDescriptor: canary.descriptor.bind(canary) });
    const message = this.message(cause);
    assert(message.includes('docker-invocation(unavailable)'));
    assert(!message.includes('CANARY'));
  }
  codes(): void {
    const error = new PlanningBlockedError([{ code: 'private-CANARY', message: 'BLOCKER_CANARY' }]);
    const message = this.render(error);
    assert(message.startsWith('INVALID_SOURCE_BLOCKER '));
    assert(!message.includes('CANARY'));
  }
  measured(): void {
    const value = this.message({
      category: 'engine',
      kind: 'timeout',
      elapsedMs: 5001,
      status: null,
      signal: 'SIGTERM',
    });
    assert(value.includes('docker-invocation(engine:timeout)'));
    assert(value.includes('docker-timing(5001ms,status:null,signal:SIGTERM)'));
  }
  badTiming(): void {
    for (const fields of [
      { elapsedMs: 'TIMING_CANARY', status: 1, signal: null },
      { elapsedMs: 1, status: 'STATUS_CANARY', signal: null },
      { elapsedMs: 1, status: 1, signal: 'SIGNAL_CANARY' },
    ]) {
      const message = this.message({ category: 'engine', kind: 'nonzero-exit', ...fields });
      assert(message.includes('docker-timing(unavailable)'));
      assert(!message.includes('CANARY'));
    }
  }
  timingGetters(): void {
    const canary = new CauseGetterCanary();
    const cause = { category: 'engine', kind: 'timeout', status: null, signal: null };
    Object.defineProperty(cause, 'elapsedMs', { get: canary.read.bind(canary) });
    assert(this.message(cause).includes('docker-timing(unavailable)'));
    assert.equal(canary.called, false);
  }
  private message(cause: unknown): string {
    const error = new PlanningBlockedError([
      { code: 'DOCKER_UNAVAILABLE', message: 'BLOCKER_CANARY' },
    ]);
    error.cause = cause;
    return this.render(error);
  }
  private render(error: PlanningBlockedError): string {
    try {
      NpmSourceProgram.failed(error);
    } catch (failure) {
      assert(failure instanceof Error);
      assert.equal(failure.cause, undefined);
      return failure.message;
    }
    throw new Error('Expected fixture error');
  }
}
const suite = new PlanningEvidenceUnit();
test(
  'unit: npm failure formatter retains known native evidence while omitting private cause and blocker text',
  suite.known.bind(suite),
);
test(
  'unit: npm failure formatter cannot print arbitrary cause category or kind values',
  suite.unknown.bind(suite),
);
test(
  'unit: npm failure formatter does not invoke cause or field getters',
  suite.getters.bind(suite),
);

test(
  'unit: npm evidence formatter contains errors from proxy descriptor traps',
  suite.proxies.bind(suite),
);
test(
  'unit: npm evidence formatter rejects non-identifier provider blocker codes',
  suite.codes.bind(suite),
);

test(
  'unit: shared fixture reports retain validated exact invocation timing exit status and signal',
  suite.measured.bind(suite),
);
test(
  'unit: shared fixture timing rejects arbitrary provider fields without output leaks',
  suite.badTiming.bind(suite),
);
test(
  'unit: shared fixture timing never invokes provider field accessors',
  suite.timingGetters.bind(suite),
);

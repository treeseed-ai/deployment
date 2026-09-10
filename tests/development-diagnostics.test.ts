import { expect, it } from 'vitest';
import { developmentDiagnosticEvents } from '../src/supervisor/development-diagnostics.js';
import { developmentContainerSchema } from '../src/supervisor/development-container-contract.js';

it('returns bounded structured error metadata without messages, SQL or credentials', () => {
  const event = { event: 'operation.internal-error', operationId: 'communications.send', requestId: 'req-1', code: '53300', name: 'error',
    message: 'private secret value', sql: 'private SQL', token: 'private token', constraint: 'not an identifier' };
  expect(developmentDiagnosticEvents(`raw private secret\n${JSON.stringify(event)}\n${JSON.stringify({ event: 'arbitrary', code: 'SECRET' })}`))
    .toEqual([{ event: 'operation.internal-error', operationId: 'communications.send', requestId: 'req-1', code: '53300', name: 'error' }]);
  expect(developmentDiagnosticEvents(Array(500).fill(JSON.stringify(event)).join('\n'))).toHaveLength(200);
});

it('diagnostic requests retain fixed registered target scope with no arbitrary log paths', () => {
  const input = { operation: 'development.container', sessionId: 'dev-test', targetId: 'service', action: 'logs' };
  expect(developmentContainerSchema.parse(input)).toEqual(input);
  for (const extra of [{ path: '/etc/credentials' }, { container: 'unrelated' }, { targetId: 'postgres' }, { sessionId: '../escape' }])
    expect(() => developmentContainerSchema.parse({ ...input, ...extra })).toThrow();
});

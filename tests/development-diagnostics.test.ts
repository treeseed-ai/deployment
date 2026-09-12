import { expect, it } from 'vitest';
import { developmentDiagnosticEvents, developmentStartupCode } from '../src/supervisor/development-diagnostics.js';
import { developmentContainerSchema } from '../src/supervisor/development-container-contract.js';

it('returns bounded structured error metadata without messages, SQL or credentials', () => {
  const event = { event: 'operation.internal-error', operationId: 'communications.send', requestId: 'req-1', code: '53300', name: 'error',
    message: 'private secret value', sql: 'private SQL', token: 'private token', constraint: 'not an identifier' };
  expect(developmentDiagnosticEvents(`raw private secret\n${JSON.stringify(event)}\n${JSON.stringify({ event: 'arbitrary', code: 'SECRET' })}`))
    .toEqual([{ event: 'operation.internal-error', operationId: 'communications.send', requestId: 'req-1', code: '53300', name: 'error' }]);
  expect(developmentDiagnosticEvents(Array(500).fill(JSON.stringify(event)).join('\n'))).toHaveLength(200);
});

it('diagnostic requests retain fixed registered target scope with no arbitrary log paths', () => {
  const input = { operation: 'development.container', sessionId: 'dev-test', projectId: 'api', targetId: 'service', action: 'logs' };
  expect(developmentContainerSchema.parse(input)).toEqual(input);
  for (const extra of [{ path: '/etc/credentials' }, { container: 'unrelated' }, { targetId: 'postgres' }, { sessionId: '../escape' }])
    expect(() => developmentContainerSchema.parse({ ...input, ...extra })).toThrow();
});

it('reports startup failures even when Node cannot start structured application logging', () => {
  expect(developmentDiagnosticEvents("SyntaxError: module '/private/path' does not provide an export named secretValue"))
    .toEqual([{event:'development.startup-error',code:'EXPORT_MISSING'}]);
});

it('classifies AI runtime package failures without forwarding module paths', () => {
	for (const [name, code] of [['@ai-platform/common', 'AI_COMMON_MODULE_MISSING'], ['@hono/node-server', 'HONO_SERVER_MODULE_MISSING'],
		['hono', 'HONO_MODULE_MISSING'], ['pg', 'POSTGRES_MODULE_MISSING'], ['@aws-sdk/client-s3', 'S3_MODULE_MISSING']] as const)
		expect(developmentStartupCode(`Error [ERR_MODULE_NOT_FOUND]: Cannot find package '${name}' imported from /app/main.js`)).toBe(code);
});

it('exposes only a bounded public package name for missing-package diagnostics', () => {
	expect(developmentDiagnosticEvents("Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@ai-platform/common' imported from /app/main.js"))
		.toEqual([{ event: 'development.startup-error', code: 'AI_COMMON_MODULE_MISSING', package: '@ai-platform/common' }]);
	expect(developmentDiagnosticEvents("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/private/path.js' imported from /app/main.js"))
		.toEqual([{ event: 'development.startup-error', code: 'ERR_MODULE_NOT_FOUND', moduleScope: 'application', module: 'private/path.js' }]);
});

it('classifies structured startup phases without forwarding cause text', () => {
  const event = { event: 'operation.internal-error', operationId: 'api.startup.entrypoint', code: 'MIGRATIONS_FAILED', message: 'private SQL and password' };
  expect(developmentStartupCode(JSON.stringify(event))).toBe('API_ENTRYPOINT_MIGRATIONS_FAILED');
  expect(developmentStartupCode(JSON.stringify({ ...event, code: 'unsafe secret value' }))).toBe('');
});

import { beforeEach, expect, it, vi } from 'vitest';
import { executePostgresTransferCommand } from '../src/manager/postgres-transfer.js';
import { supervisorOperationSchema } from '../src/supervisor/protocol.js';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('../src/supervisor/client.js', () => ({ requestSupervisor: invoke }));
beforeEach(() => vi.resetAllMocks());
const selection = { componentId: 'api', sourceRuntimeDigest: `sha256:${'a'.repeat(64)}`, targetRuntimeDigest: `sha256:${'b'.repeat(64)}`,
  topologyDigest: `sha256:${'c'.repeat(64)}`, configurationDigest: `sha256:${'d'.repeat(64)}`, allowLocaleConversion: false };
const request = (plan = false) => ({ handlerId: 'local.host.postgres.transfer.prepare', arguments: [], options: { plan, payload: JSON.stringify(selection) } });
it.each([true, false])('passes exact preparation and explicit planOnly=%s to the fixed root operation', async plan => {
  invoke.mockResolvedValue({ action: plan ? 'planned' : 'prepared', selectionDigest: selection.topologyDigest });
  await executePostgresTransferCommand(request(plan), true);
  expect(invoke).toHaveBeenCalledExactlyOnceWith({ operation: 'postgres.transfer.prepare', ...selection, planOnly: plan });
});
it('denies remote callers and malformed/expanded payloads before invoking root', async () => {
  await expect(executePostgresTransferCommand(request(), false)).rejects.toThrow('protected local');
  for (const payload of ['synthetic-secret', JSON.stringify({ ...selection, password: 'synthetic-secret' }), 'x'.repeat(16385)]) {
    const error = await executePostgresTransferCommand({ ...request(), options: { payload } }, true).catch(error => error);
    expect(error.message).not.toContain('synthetic-secret');
  }
  expect(invoke).not.toHaveBeenCalled();
});
it('validates redacted status and rejects credential-bearing supervisor output', async () => {
  const input = { handlerId: 'local.host.postgres.transfer.status', arguments: [], options: {} };
  invoke.mockResolvedValue(null); expect(await executePostgresTransferCommand(input, true)).toBeNull();
  invoke.mockResolvedValue({ password: 'synthetic-secret' });
  await expect(executePostgresTransferCommand(input, true)).rejects.toThrow();
});
it('preserves the shared selection refinement at the privileged protocol boundary', () => {
  const operation = { operation: 'postgres.transfer.prepare', ...selection, planOnly: true };
  expect(supervisorOperationSchema.safeParse(operation).success).toBe(true);
  expect(supervisorOperationSchema.safeParse({ ...operation, targetRuntimeDigest: selection.sourceRuntimeDigest }).success).toBe(false);
  expect(supervisorOperationSchema.safeParse({ ...operation, password: 'synthetic-secret' }).success).toBe(false);
});

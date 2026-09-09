import { expect, it, vi } from 'vitest';
import { probeRunnerCustody } from '../src/supervisor/runner-custody-probe.js';
import { supervisorOperationSchema } from '../src/supervisor/protocol.js';

function fixture() {
  const state = { id: 'a'.repeat(64), project: 'treeseed-api', service: 'operations-runner', running: true, startedAt: '2026-09-09T10:00:00Z' };
  const result = { status: 'authenticated', httpStatus: 204, trustModifiedAt: '2026-09-09T10:01:00Z' };
  const command = vi.fn((_exe: string, args: readonly string[], _input?: string): unknown => JSON.stringify(args[0] === 'inspect' ? state : result));
  return { state, result, command };
}
it('probes only the observed managed container and identifies startup trust ordering', () => {
  const f = fixture(); expect(probeRunnerCustody(f.command)).toMatchObject({ status: 'authenticated', startedBeforeTrustFile: true });
  expect(f.command.mock.calls[1]![1]).toEqual(['exec', '-i', 'a'.repeat(64), 'node', '--input-type=module']);
  expect(f.command.mock.calls[1]![2]).toContain('auth/token/revoke-self');
});
it.each(['project', 'service', 'id', 'running', 'startedAt'])('rejects invalid %s before execution', key => {
  const f = fixture(); Object.assign(f.state, { [key]: key === 'running' ? false : 'foreign' });
  expect(() => probeRunnerCustody(f.command)).toThrow('unavailable'); expect(f.command).toHaveBeenCalledTimes(1);
});
it('never exposes arbitrary container output or provider secrets', () => {
  const f = fixture(); Object.assign(f.result, { token: 'sensitive' });
  expect(() => probeRunnerCustody(f.command)).toThrow('no provider diagnostics exposed');
  f.command.mockImplementation(() => { throw new Error('private output'); });
  expect(() => probeRunnerCustody(f.command)).toThrow('no provider diagnostics exposed');
});
it('forbids caller supplied commands, paths, and container selectors', () => {
  expect(supervisorOperationSchema.parse({ operation: 'custody.runner.probe' })).toEqual({ operation: 'custody.runner.probe' });
  for (const field of ['command', 'url', 'path', 'container']) expect(supervisorOperationSchema.safeParse({ operation: 'custody.runner.probe', [field]: 'anything' }).success).toBe(false);
});

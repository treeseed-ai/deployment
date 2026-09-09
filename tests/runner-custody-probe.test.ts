import { expect, it, vi } from 'vitest';
import { probeRunnerCustody, recoverRunnerCustody } from '../src/supervisor/runner-custody-probe.js';
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
it.each(['project', 'service', 'id', 'startedAt'])('rejects invalid %s before execution', key => {
  const f = fixture(); Object.assign(f.state, { [key]: key === 'running' ? false : 'foreign' });
  expect(() => probeRunnerCustody(f.command)).toThrow('unavailable'); expect(f.command).toHaveBeenCalledTimes(1);
});
it('leaves an explicitly stopped released runner stopped', () => {
  const f = fixture(); f.state.running = false;
  expect(recoverRunnerCustody(f.command)).toMatchObject({action:'noop',status:'inactive'});
  expect(f.command).toHaveBeenCalledTimes(1);
});
it('renders a complete JSON object around the Docker template fields', () => {
  const f = fixture(); probeRunnerCustody(f.command);
  const format = f.command.mock.calls[0]![1][3]!;
  expect(JSON.parse(format.replace(/\{\{.*?\}\}/gu, 'null'))).toEqual({id:null,project:null,service:null,running:null,startedAt:null});
});

function recoveryFixture(exitCode = '0') {
  const f = fixture();
  f.command.mockImplementation((_exe, args) => {
    if(args[0] === 'ps') return 'treeseed-api-operations-runner-1';
    if(args[0] === 'inspect') return JSON.stringify(args[3]?.includes('"Config"') ? {
      Config:{Labels:{'com.docker.compose.project':'treeseed-api','com.docker.compose.service':'operations-runner'}},State:{Running:true},
    } : f.state);
    if(args[0] === 'exec') return JSON.stringify(f.result);
    if(args[0] === 'wait') return exitCode;
    if(args[0] === 'start') f.state.startedAt = '2026-09-09T10:02:00Z';
    return '';
  });
  return f;
}
it('drains and restarts only after successful custody verification, then noops', () => {
  const f = recoveryFixture();
  expect(recoverRunnerCustody(f.command)).toMatchObject({action:'restarted',status:'authenticated',startedBeforeTrustFile:false});
  expect(f.command.mock.calls.filter(call => call[1][0] === 'kill').map(call=>call[1])).toEqual([['kill','--signal','SIGTERM','treeseed-api-operations-runner-1']]);
  expect(recoverRunnerCustody(f.command)).toMatchObject({action:'noop'});
  expect(f.command.mock.calls.filter(call => call[1][0] === 'start')).toHaveLength(1);
});
it('restores but does not claim clean recovery after incomplete drain', () => {
  const f = recoveryFixture('1');
  expect(()=>recoverRunnerCustody(f.command)).toThrow('drain is incomplete');
  expect(f.command.mock.calls.filter(call => call[1][0] === 'start')).toHaveLength(1);
});
it('does not interrupt a runner when custody prerequisites fail', () => {
  const f = recoveryFixture(); Object.assign(f.result,{status:'login-rejected'});
  expect(()=>recoverRunnerCustody(f.command)).toThrow('prerequisites');
  expect(f.command.mock.calls.some(call=>call[1][0] === 'kill')).toBe(false);
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

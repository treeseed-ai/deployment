import { expect, it, vi } from 'vitest';
import { drainCandidateRunner, drainReleasedRunner, restoreReleasedRunner } from '../src/supervisor/development-runner.js';

function runner(owned = true, exit = '0') {
  return vi.fn((_exe: string, args: readonly string[]) => {
    if (args[0] === 'ps') return 'treeseed-api-operations-runner-1';
    if (args[0] === 'inspect') return JSON.stringify({ Config: { Labels: owned ? {
      'com.docker.compose.project': 'treeseed-api', 'com.docker.compose.service': 'operations-runner',
    } : {} }, State: { Running: true } });
    return args[0] === 'wait' ? exit : '';
  });
}
it('drains only the exact managed runner without SIGKILL', () => {
  const command = runner(); expect(drainReleasedRunner(command)).toBe(true);
  expect(command.mock.calls.map(call => call[1][0])).toEqual(['ps', 'inspect', 'kill', 'wait']);
  expect(command.mock.calls[2]?.[1]).toContain('SIGTERM');
  restoreReleasedRunner(command); expect(command.mock.calls.at(-1)?.[1]).toEqual(['start', 'treeseed-api-operations-runner-1']);
});
it('rejects unowned containers and unsuccessful drain', () => {
  const unowned = runner(false); expect(() => drainReleasedRunner(unowned)).toThrow('ownership');
  expect(unowned.mock.calls).toHaveLength(2);
  expect(() => drainReleasedRunner(runner(true, '137'))).toThrow('drain is incomplete');
});
it('drains candidate work before removal and rejects another session identity', () => {
  const command = vi.fn((_exe: string, args: readonly string[]) => args[0] === 'ps' ? 'present' : args[0] === 'inspect'
    ? JSON.stringify({ Config: { Labels: { 'org.treeseed.development.session': 'dev-test', 'org.treeseed.development.target': 'api.operations-runner' } }, State: { Running: true } }) : args[0] === 'wait' ? '0' : '');
  drainCandidateRunner(command, 'dev-test');
  expect(command.mock.calls.map(call => call[1][0])).toEqual(['ps', 'inspect', 'kill', 'wait']);
  expect(() => drainCandidateRunner(command, 'dev-other')).toThrow('ownership');
  expect(() => drainCandidateRunner(command, '../escape')).toThrow('Invalid');
});

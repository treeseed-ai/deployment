import { describe, expect, it } from 'vitest';
import { stopReleasedApi, restoreReleasedApi } from '../src/supervisor/development-api-handoff.js';
import type { CommandRunner } from '../src/supervisor/compose-runtime.js';

describe('managed API listener handoff', () => {
  function fixture(service = 'api') {
    let running = true;
    const calls: string[][] = [];
    const command: CommandRunner = (_binary, args) => {
      calls.push([...args]);
      if (args[0] === 'inspect') return JSON.stringify({ labels: {
        'com.docker.compose.project': 'treeseed-api', 'com.docker.compose.service': service,
      }, running });
      if (args[0] === 'stop') running = false;
      if (args[0] === 'start') running = true;
      return '';
    };
    return { command, calls };
  }
  it('records restoration before stopping only the API and restores on explicit exit', () => {
    const f = fixture();
    expect(stopReleasedApi(f.command, () => f.calls.push(['intent']))).toBe(true);
    expect(f.calls.map(call => call[0])).toEqual(['inspect','intent','stop','inspect']);
    expect(f.calls[2]).toEqual(['stop','--time','30','treeseed-api-api-1']);
    expect(stopReleasedApi(f.command, () => { throw new Error('duplicate'); })).toBe(false);
    restoreReleasedApi(f.command);
    expect(f.calls.at(-1)).toEqual(['start','treeseed-api-api-1']);
  });
  it('does not stop or restore another service', () => {
    const f = fixture('openbao');
    expect(() => stopReleasedApi(f.command, () => {})).toThrow('ownership');
    expect(() => restoreReleasedApi(f.command)).toThrow('ownership');
    expect(f.calls.every(call => call[0] === 'inspect')).toBe(true);
  });
  it('does not stop unless restoration intent is durable', () => {
    const f = fixture();
    expect(() => stopReleasedApi(f.command, () => { throw new Error('journal'); })).toThrow('journal');
    expect(f.calls).toHaveLength(1);
  });
});

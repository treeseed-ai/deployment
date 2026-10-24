import { describe, expect, it } from 'vitest';
import { stopReleasedApi, restoreReleasedApi } from '../src/supervisor/development-api-handoff.js';
import type { CommandRunner } from '../src/supervisor/compose-runtime.js';

describe('managed API listener handoff', () => {
  function fixture(service = 'api') {
    let running = true;
    const calls: string[][] = [];
    const command: CommandRunner = (_binary, args) => {
      calls.push([...args]);
      if (args[0] === 'ps') return 'treeseed-api-api-1\n';
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
    expect(f.calls.map(call => call[0])).toEqual(['ps','inspect','intent','stop','inspect']);
    expect(f.calls[3]).toEqual(['stop','--time','30','treeseed-api-api-1']);
    expect(stopReleasedApi(f.command, () => { throw new Error('duplicate'); })).toBe(false);
    restoreReleasedApi(f.command);
    expect(f.calls.at(-1)).toEqual(['start','treeseed-api-api-1']);
  });
  it('does not stop or restore another service', () => {
    const f = fixture('openbao');
    expect(() => stopReleasedApi(f.command, () => {})).toThrow('ownership');
    expect(() => restoreReleasedApi(f.command)).toThrow('ownership');
    expect(f.calls.every(call => ['ps','inspect'].includes(call[0]!))).toBe(true);
  });
  it('does not stop unless restoration intent is durable', () => {
    const f = fixture();
    expect(() => stopReleasedApi(f.command, () => { throw new Error('journal'); })).toThrow('journal');
    expect(f.calls.map(call => call[0])).toEqual(['ps','inspect']);
  });
  it('starts no restoration obligation when the released API listener is proven absent', () => {
    const calls: string[][] = [];
    const command: CommandRunner = (_binary, args) => {
      calls.push([...args]);
      if (args[0] !== 'ps') throw new Error('An absent listener must not be inspected or stopped.');
      return '';
    };
    expect(stopReleasedApi(command, () => { throw new Error('No original listener to restore.'); })).toBe(false);
    expect(calls).toEqual([['ps','--all','--filter','name=^/treeseed-api-api-1$','--format','{{.Names}}']]);
    expect(() => restoreReleasedApi(command)).toThrow('must not be inspected');
  });
  it.each(['foreign', 'treeseed-api-api-1\nforeign', 'null', '[]'])('rejects foreign or malformed listener inventory %s', output => {
    const calls: string[][] = [];
    const command: CommandRunner = (_binary, args) => { calls.push([...args]); return output; };
    expect(() => stopReleasedApi(command, () => { throw new Error('Unexpected restoration intent.'); })).toThrow('inventory');
    expect(calls.map(call => call[0])).toEqual(['ps']);
  });
  it('preserves inventory transport failure without claiming the listener is absent', () => {
    const calls: string[][] = [];
    const command: CommandRunner = (_binary, args) => { calls.push([...args]); throw new Error('Docker inventory unavailable'); };
    expect(() => stopReleasedApi(command, () => { throw new Error('Unexpected restoration intent.'); })).toThrow('Docker inventory unavailable');
    expect(calls.map(call => call[0])).toEqual(['ps']);
  });
});

import { expect, it, vi } from 'vitest';
import { composeFailureDiagnostics } from '../src/supervisor/compose-diagnostics.js';

it('returns safe PostgreSQL startup reasons through fixed bounded log capture', () => {
  const command = vi.fn((_exe: string, args: readonly string[]) => args[0] === 'ps' ? 'a'.repeat(64) : 'postgres\texited\tunhealthy\t1');
  const capture = vi.fn(() => 'FATAL: database files are incompatible with server\npassword=private\nSQL sensitive');
  expect(composeFailureDiagnostics('postgres', 'treeseed-postgres', command, capture)).toEqual([
    { service: 'postgres', state: 'exited', health: 'unhealthy', exitCode: 1,
      diagnostic: { code: 'postgres_startup_failed', reasons: ['data-version-incompatible', 'startup-fatal'] } },
  ]);
  expect(capture).toHaveBeenCalledWith('/usr/bin/docker', ['logs', '--tail', '80', 'a'.repeat(64)], '');
});
it('retains service status without falling back to raw logs or another provider parser', () => {
  const command = vi.fn((_exe: string, args: readonly string[]) => args[0] === 'ps' ? 'b'.repeat(64) : 'postgres\texited\tnone\t1');
  const capture = vi.fn(() => 'opaque confidential startup detail');
  const value = composeFailureDiagnostics('postgres', 'treeseed-postgres', command, capture);
  expect(value).toEqual([{ service: 'postgres', state: 'exited', health: 'none', exitCode: 1 }]);
  capture.mockClear();
  composeFailureDiagnostics('admin', 'treeseed-admin', command, capture);
  expect(capture).not.toHaveBeenCalled();
});

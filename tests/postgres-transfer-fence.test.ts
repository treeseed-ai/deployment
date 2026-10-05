import { expect, it, vi } from 'vitest';
import { fencePostgresSourceNetworks, inspectPostgresSourceNetworks, terminatePostgresTransferWriters } from '../src/postgres/transfer-fence.js';
import type { PostgresInspectionSession } from '../src/postgres/inventory.js';

function fixture(mode = 'private') {
  const state = { id: 'a'.repeat(64), mode, networks: { private: { NetworkID: 'b'.repeat(64) } } as Record<string, { NetworkID: string }> };
  const docker = vi.fn(async (args: string[]) => {
    if (args[0] === 'inspect') return JSON.stringify(state);
    if (args[0] === 'network') { state.networks = {}; return ''; }
    throw new Error('unexpected command');
  });
  return { state, docker };
}
it('disconnects only the attested source and never removes shared networks', async () => {
  const f = fixture(), before = await inspectPostgresSourceNetworks(f.state.id, f.docker);
  expect(await fencePostgresSourceNetworks(f.state.id, before.digest, f.docker)).toMatchObject({ fenced: true });
  expect(f.docker.mock.calls.filter(([args]) => args[0] === 'network')).toEqual([[['network','disconnect','b'.repeat(64),f.state.id],30,false]]);
});
it.each(['host','container:other','service:other'])('rejects shared network namespace %s', async mode => {
  const f = fixture(mode); await expect(inspectPostgresSourceNetworks(f.state.id, f.docker)).rejects.toThrow('namespace');
  expect(f.docker).toHaveBeenCalledOnce();
});
it('rejects moved inventory before disconnecting', async () => {
  const f = fixture(), before = await inspectPostgresSourceNetworks(f.state.id, f.docker);
  f.state.networks.private!.NetworkID = 'c'.repeat(64);
  await expect(fencePostgresSourceNetworks(f.state.id, before.digest, f.docker)).rejects.toThrow('changed');
  expect(f.docker.mock.calls.some(([args]) => args[0] === 'network')).toBe(false);
});
it('already isolated source requires no network mutation', async () => {
  const f = fixture('none'); f.state.networks = { none: { NetworkID: 'b'.repeat(64) } };
  const before = await inspectPostgresSourceNetworks(f.state.id, f.docker);
  await fencePostgresSourceNetworks(f.state.id, before.digest, f.docker);
  expect(f.docker.mock.calls.some(([args]) => args[0] === 'network')).toBe(false);
});
it('terminates only selected database roles and checks that unknown clients do not remain', async () => {
  const query = vi.fn().mockResolvedValueOnce({ rows: [{ selected: true }] }).mockResolvedValueOnce({ rows: [{ terminated: true }] }).mockResolvedValueOnce({ rows: [{ idle: true }] });
  await expect(terminatePostgresTransferWriters({ query } as PostgresInspectionSession, 'application', ['runtime','migration'])).resolves.toEqual({ fenced: true });
  expect(query.mock.calls[1]![1]).toEqual(['application',['runtime','migration']]);
  expect(query.mock.calls[1]![0]).toContain('pid<>pg_backend_pid()');
});
it.each(['wrong-database','termination-failed','unknown-client'])('retains hold when %s occurs', async failure => {
  const query = vi.fn().mockResolvedValueOnce({ rows: [{ selected: failure !== 'wrong-database' }] })
    .mockResolvedValueOnce({ rows: [{ terminated: failure !== 'termination-failed' }] })
    .mockResolvedValueOnce({ rows: [{ idle: failure !== 'unknown-client' }] });
  await expect(terminatePostgresTransferWriters({ query } as PostgresInspectionSession, 'application', ['runtime'])).rejects.toThrow('retain the recovery hold');
});

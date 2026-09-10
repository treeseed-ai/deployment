import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { withAttestedPostgresSource } from '../src/postgres/source-session.js';
import { supervisorOperationSchema } from '../src/supervisor/protocol.js';

const fake = vi.hoisted(() => ({ options: {} as Record<string, unknown>, connect: vi.fn(), end: vi.fn(), query: vi.fn(), on: vi.fn() }));
vi.mock('pg', () => ({ default: { Client: class {
  constructor(options: Record<string, unknown>) { fake.options = options; }
  connect = fake.connect; end = fake.end; query = fake.query; on = fake.on;
} } }));
const selection = { container: 'a'.repeat(64), database: 'application', username: 'postgres',
  clusterIdentity: deploymentDigest({ cluster: '123' }), major: 16 as const };
beforeEach(() => {
  vi.spyOn(process, 'getuid').mockReturnValue(0); vi.stubEnv('PGREPLICATION', '');
  fake.connect.mockResolvedValue(undefined); fake.end.mockResolvedValue(undefined);
  fake.query.mockResolvedValue({ rows: [{ database: 'application', major: 16, cluster: '123' }] });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
function fixture() {
  const state = { id: selection.container, pid: 1234, started: '2026-09-10T00:00:00Z', running: true };
  const docker = vi.fn(async () => JSON.stringify(state));
  const run = vi.fn(async () => ({ digest: 'safe' }));
  return { state, docker, run, execute: () => withAttestedPostgresSource(selection, docker, run) };
}
it('uses only attested process-local socket and explicit read-only options; closes once', async () => {
  const f = fixture(); expect(await f.execute()).toEqual({ digest: 'safe' });
  expect(fake.options).toMatchObject({ host: '/proc/1234/root/var/run/postgresql', port: 5432,
    ssl: false, user: 'postgres', database: 'application', options: '-c search_path=pg_catalog -c default_transaction_read_only=on' });
  expect(f.docker).toHaveBeenCalledTimes(3); expect(fake.end).toHaveBeenCalledOnce();
});
it('requires root and rejects ambient replication before Docker', async () => {
  const f = fixture(); vi.mocked(process.getuid!).mockReturnValue(1000);
  await expect(f.execute()).rejects.toThrow('source unchanged'); expect(f.docker).not.toHaveBeenCalled();
  vi.mocked(process.getuid!).mockReturnValue(0); vi.stubEnv('PGREPLICATION', 'database');
  await expect(f.execute()).rejects.toThrow('source unchanged'); expect(f.docker).not.toHaveBeenCalled();
});
it.each([{ database: 'foreign' }, { major: 17 }, { cluster: '456' }])('denies identity mismatch before callback: %j', async change => {
  const f = fixture(); fake.query.mockResolvedValue({ rows: [{ database: 'application', major: 16, cluster: '123', ...change }] });
  await expect(f.execute()).rejects.toThrow('source unchanged'); expect(f.run).not.toHaveBeenCalled(); expect(fake.end).toHaveBeenCalledOnce();
});
it.each(['pid', 'started'] as const)('rejects %s changes after connection and after fingerprint', async field => {
  const f = fixture(); fake.connect.mockImplementation(async () => { Object.assign(f.state, { [field]: field === 'pid' ? 678 : 'changed' }); });
  await expect(f.execute()).rejects.toThrow('source unchanged'); expect(f.run).not.toHaveBeenCalled();
  fake.connect.mockResolvedValue(undefined);
  f.run.mockImplementation(async () => { Object.assign(f.state, { [field]: field === 'pid' ? 999 : 'again' }); return { digest: 'safe' }; });
  await expect(f.execute()).rejects.toThrow('source unchanged'); expect(fake.end).toHaveBeenCalledTimes(2);
});
it('redacts driver and callback errors and always closes', async () => {
  const f = fixture(); fake.connect.mockRejectedValue(new Error('password=secret database rows'));
  await expect(f.execute()).rejects.toThrow('Attested PostgreSQL source session unavailable or changed (connect/unavailable); source unchanged.');
  expect(fake.end).toHaveBeenCalledOnce(); expect(f.run).not.toHaveBeenCalled();
});
it('rejects process-path injection and non-running or foreign container state', async () => {
  const f = fixture(); Object.assign(f.state, { pid: '../other' });
  await expect(f.execute()).rejects.toThrow('source unchanged'); expect(fake.connect).not.toHaveBeenCalled();
  Object.assign(f.state, { pid: 1234, running: false }); await expect(f.execute()).rejects.toThrow('source unchanged');
  Object.assign(f.state, { running: true, id: 'b'.repeat(64) }); await expect(f.execute()).rejects.toThrow('source unchanged');
});
it('wire operation accepts exact inventory digest but no SQL, paths, passwords or usernames', () => {
  const request = { operation: 'postgres.source.fingerprint', componentId: 'api', release: '1.0.0', serviceId: 'database', inventoryDigest: `sha256:${'a'.repeat(64)}` };
  expect(supervisorOperationSchema.safeParse(request).success).toBe(true);
  for (const extra of [{ sql: 'SELECT 1' }, { pid: 1234 }, { password: 'secret' }, { username: 'postgres' }, { path: '/tmp/socket' }])
    expect(supervisorOperationSchema.safeParse({ ...request, ...extra }).success).toBe(false);
});

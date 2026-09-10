import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startPostgresExport, startPostgresImport } from '../src/postgres/transfer-process.js';
import { postgresProcessReason } from '../src/postgres/transfer-diagnostic.js';

const fake = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: fake.spawn }));
const selection = { container: 'a'.repeat(64), database: 'application', username: 'migration', intentDigest: `sha256:${'b'.repeat(64)}` };
function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  fake.spawn.mockReturnValue(child); return child;
}
beforeEach(() => { vi.spyOn(process, 'getuid').mockReturnValue(0); });
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); });
it('exports only through fixed no-password local arguments with bounded process lifetime', async () => {
  const child = fixture(), result = startPostgresExport(selection);
  const [executable, args, options] = fake.spawn.mock.calls[0]!;
  expect(executable).toBe('/usr/bin/docker'); expect(options.shell).toBeUndefined();
  expect(args).toContain('PGPASSFILE=/dev/null'); expect(args).not.toContain('PGSERVICE=');
  expect(args.slice(0, 5)).toEqual(['exec','-i',selection.container,'env','-i']);
  expect(args.slice(args.indexOf('timeout'))).toEqual(['timeout','-s','TERM','-k','5','600',
    'pg_dump','--format=custom','--no-tablespaces','--no-password','-h','/var/run/postgresql','-p','5432','-U','migration','-d','application']);
  expect(child.stdin.writableEnded).toBe(true); expect(result.applicationName.length).toBeLessThanOrEqual(63);
  child.emit('close', 0); await expect(result.completed).resolves.toBeUndefined();
});
it('imports as restricted migration login, sets only the bound owner, and uses one transaction', async () => {
  const child = fixture(), result = startPostgresImport({ ...selection, owner: 'owner' });
  const args = fake.spawn.mock.calls[0]![1];
  expect(args).toContain('--single-transaction'); expect(args).toContain('--role=owner');
  expect(args).toContain('/run/postgres/socket'); expect(args).not.toContain('--clean');
  expect(child.stdin.writableEnded).toBe(false); child.emit('close', 0); await result.completed;
});
it.each([{ container: 'name' }, { database: '../other' }, { username: 'user;DROP' }, { intentDigest: 'unbound' }])('rejects malformed selection %j before process creation', change => {
  expect(() => startPostgresExport({ ...selection, ...change })).toThrow('selection'); expect(fake.spawn).not.toHaveBeenCalled();
});
it('requires root and distinct migration login / owner', () => {
  expect(() => startPostgresImport({ ...selection, owner: selection.username })).toThrow('selection');
  vi.mocked(process.getuid!).mockReturnValue(1000);
  expect(() => startPostgresExport(selection)).toThrow('selection'); expect(fake.spawn).not.toHaveBeenCalled();
});
it('discards process diagnostics and reports that failed imports still require containment', async () => {
  const child = fixture(), result = startPostgresImport({ ...selection, owner: 'owner' });
  child.stderr.write('password=private and secret rows'); child.emit('close', 1);
  await expect(result.completed).rejects.toThrow('explicit containment required');
});
it('classifies extension ownership without exposing database output', async () => {
  const child = fixture(), result = startPostgresImport({ ...selection, owner: 'owner' });
  child.stderr.write('pg_restore: error: must be owner of exten');
  child.stderr.write('sion pgcrypto\nCommand was: secret SQL payload'); child.emit('close', 1);
  const error: unknown = await result.completed.catch(error => error);
  expect(postgresProcessReason(error)).toBe('extension-owner');
  expect(String(error)).not.toContain('secret SQL');
});
it('bounds the attach process without claiming Docker disconnect killed its database session', async () => {
  vi.useFakeTimers(); const child = fixture(), result = startPostgresExport(selection);
  vi.advanceTimersByTime(615000); expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  child.emit('close', null); await expect(result.completed).rejects.toThrow('containment');
});

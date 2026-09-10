import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupPostgresSourceCopies } from '../src/supervisor/postgres-copy-cleanup.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'treeseed-copy-cleanup-')); roots.push(root);
  const copy = join(root, 'postgres-source-ABC123'); mkdirSync(copy, { mode: 0o700 });
  const id = 'a'.repeat(64);
  const value = { name: '/treeseed-postgres-copy-00000000-0000-0000-0000-000000000000', owner: 'postgres-source-copy', network: 'none', readonly: true,
    mounts: [{ Type: 'bind', Source: join(copy, 'original/postgres'), Destination: '/var/lib/postgresql/data' },
      { Type: 'bind', Source: join(copy, 'helper-config'), Destination: '/run/treeseed-source' }] };
  const docker = vi.fn(async (args: string[]) => args[0] === 'ps' ? (args.includes('--filter') ? id : '') : args[0] === 'inspect' ? JSON.stringify(value) : '');
  return { root, copy, id, value, docker };
}
it('removes only attested orphan helpers then their private copies, and repeats noop', async () => {
  const f = fixture(); expect(await cleanupPostgresSourceCopies(f.root, f.docker)).toEqual({ removed: 1 });
  expect(f.docker).toHaveBeenCalledWith(['rm', '--force', f.id], 30, false); expect(existsSync(f.copy)).toBe(false);
  f.docker.mockResolvedValue(''); expect(await cleanupPostgresSourceCopies(f.root, f.docker)).toEqual({ removed: 0 });
});
it.each(['original-mount', 'network', 'owner'] as const)('preserves resources with %s mismatch', async mismatch => {
  const f = fixture();
  if (mismatch === 'original-mount') f.value.mounts[0]!.Source = '/var/lib/treeseed/agent/postgres';
  if (mismatch === 'network') f.value.network = 'bridge';
  if (mismatch === 'owner') f.value.owner = 'unrelated';
  await expect(cleanupPostgresSourceCopies(f.root, f.docker)).rejects.toThrow();
  expect(f.docker.mock.calls.some(([args]) => args[0] === 'rm')).toBe(false); expect(existsSync(f.copy)).toBe(true);
});
it('does not delete a copy still mounted by another container', async () => {
  const f = fixture(); f.docker.mockImplementation(async args => args[0] === 'ps' ? (args.includes('--filter') ? '' : f.id) : JSON.stringify([{ Source: f.copy }]));
  await expect(cleanupPostgresSourceCopies(f.root, f.docker)).rejects.toThrow('remains mounted'); expect(existsSync(f.copy)).toBe(true);
});
it('rejects unsafe or unexpected staging entries before Docker mutation', async () => {
  const f = fixture(); chmodSync(f.copy, 0o755);
  await expect(cleanupPostgresSourceCopies(f.root, f.docker)).rejects.toThrow('custody');
  chmodSync(f.copy, 0o700); symlinkSync(f.copy, join(f.root, 'postgres-source-DEF456'));
  await expect(cleanupPostgresSourceCopies(f.root, f.docker)).rejects.toThrow('custody'); expect(f.docker).not.toHaveBeenCalled();
});

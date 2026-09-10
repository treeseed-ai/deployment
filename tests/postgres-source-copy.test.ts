import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { component, host } from './fixtures.js';
import { withPostgresSourceCopy } from '../src/supervisor/postgres-source-copy.js';

const fs = vi.hoisted(() => ({ write: vi.fn(), remove: vi.fn(), exists: vi.fn(() => false) }));
vi.mock('node:fs', async original => ({ ...await original<object>(), realpathSync: (path: string) => path,
  lstatSync: (path: string) => ({ uid: path.endsWith('/postgres') ? 999 : 0, gid: 999, mode: 0o700, isDirectory: () => true }),
  writeFileSync: fs.write, rmSync: fs.remove, existsSync: fs.exists, mkdirSync: vi.fn(), chmodSync: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); vi.spyOn(process, 'getuid').mockReturnValue(0); });
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const release = component('api', 'development', 'a');
  release.images[0]!.repository = 'postgres'; release.runtime.services[0]!.composeService = 'database';
  release.runtimeDigest = deploymentDigest(release.runtime);
  const staged = { component: release, configuration: host(), member: 'var/lib/treeseed/components/api/postgres',
    directory: '/private/copy', dataDirectory: '/private/copy/var/lib/treeseed/components/api/postgres',
    coveredState: ['var/lib/treeseed/components/api/postgres'], major: 16 as const, generation: 7, backupDigest: `sha256:${'b'.repeat(64)}` };
  const original = 'c'.repeat(64), helper = 'd'.repeat(64), imageId = `sha256:${'e'.repeat(64)}`;
  const observed = { image: 'postgres:16-bookworm', database: 'POSTGRES_DB=application', username: 'POSTGRES_USER=owner',
    mounts: [{ Type: 'bind', Source: `/${staged.member}`, Destination: '/var/lib/postgresql/data' }],
    running: false, restarting: false, imageId };
  const inventory = { database: 'application', major: 16, cluster: '12345',
    locale: { encoding: 'UTF8', collate: 'en_US.utf8', ctype: 'en_US.utf8', provider: 'c', version: '2.36', locale: null } };
  const docker = vi.fn(async (args: string[]) => {
    if (args[0] === 'ps') return original;
    if (args[0] === 'inspect') return JSON.stringify(observed);
    if (args[0] === 'image') return imageId;
    if (args[0] === 'run') return helper;
    if (args[0] === 'exec') return JSON.stringify(inventory);
    return '';
  });
  return { staged, original, helper, observed, inventory, docker };
}
it('opens only the copied data with a non-root, networkless, bounded helper and removes it', async () => {
  const f = fixture();
  const result = await withPostgresSourceCopy(f.staged, 'database', f.docker, async source => {
    expect(source).toMatchObject({ container: f.helper, username: 'owner', database: 'application', major: 16 });
    await source.revalidate(); return 'verified';
  });
  expect(result).toBe('verified');
  const args = f.docker.mock.calls.find(([args]) => args[0] === 'run')![0];
  expect(args).toContain('--read-only'); expect(args).toContain('--cap-drop'); expect(args).toContain('ALL');
  expect(args).toContain('none'); expect(args).toContain('999:999'); expect(args).toContain(`postgres@sha256:${'a'.repeat(64)}`);
  expect(args).toContain(`type=bind,source=${f.staged.dataDirectory},target=/var/lib/postgresql/data`);
  expect(args.join(' ')).not.toMatch(/docker.sock|POSTGRES_PASSWORD|--publish|--privileged/u);
  expect(f.docker.mock.calls.some(([args]) => ['start', 'restart'].includes(args[0]!))).toBe(false);
  expect(f.docker.mock.calls.at(-1)![0]).toEqual(['rm', '--force', f.helper]);
  for (const [path] of [...fs.write.mock.calls, ...fs.remove.mock.calls]) expect(path.startsWith(`${f.staged.directory}/`)).toBe(true);
});
it.each(['running', 'mount', 'image'] as const)('does not start a helper for changed %s custody', async failure => {
  const f = fixture();
  if (failure === 'running') f.observed.running = true;
  if (failure === 'mount') f.observed.mounts[0]!.Source = '/other';
  if (failure === 'image') f.observed.imageId = `sha256:${'f'.repeat(64)}`;
  await expect(withPostgresSourceCopy(f.staged, 'database', f.docker, async () => undefined)).rejects.toThrow();
  expect(f.docker.mock.calls.some(([args]) => args[0] === 'run')).toBe(false); expect(fs.write).not.toHaveBeenCalled();
});
it('fences the result and cleans only the helper if the original starts during export', async () => {
  const f = fixture();
  await expect(withPostgresSourceCopy(f.staged, 'database', f.docker, async () => { f.observed.running = true; })).rejects.toThrow('retain coordinated recovery');
  expect(f.docker.mock.calls.at(-1)![0]).toEqual(['rm', '--force', f.helper]);
});
it('cleans the exact allocated name after an uncertain Docker start', async () => {
  const f = fixture(), original = f.docker.getMockImplementation()!;
  f.docker.mockImplementation(async args => { if (args[0] === 'run') throw new Error('timeout'); return original(args); });
  await expect(withPostgresSourceCopy(f.staged, 'database', f.docker, async () => undefined)).rejects.toThrow('retain coordinated recovery');
  const started = f.docker.mock.calls.find(([args]) => args[0] === 'run')![0];
  expect(f.docker.mock.calls.at(-1)![0]).toEqual(['rm', '--force', started[started.indexOf('--name') + 1]]);
});
it('retains safe transfer diagnostics without driver messages or secret values', async () => {
  const f = fixture();
  const error = await withPostgresSourceCopy(f.staged, 'database', f.docker, async () => {
    throw new Error('synthetic-secret: failed SQL credential');
  }).catch(error => error as Error & { diagnostic: { stage: string } });
  expect(error.diagnostic.stage).toBe('transfer-operation');
  expect(JSON.stringify(error)).not.toMatch(/synthetic-secret|failed SQL credential/u);
  expect(error.message).not.toContain('synthetic-secret');
});

import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessions: vi.fn(), stat: vi.fn(), read: vi.fn(), realpath: vi.fn(), docker: vi.fn(), held: vi.fn(),
}));
vi.mock('node:fs', () => ({ lstatSync: mocks.stat, readFileSync: mocks.read, realpathSync: mocks.realpath }));
vi.mock('../src/manager/development-sessions.js', () => ({ DevelopmentSessionStore: class { list = mocks.sessions; } }));
vi.mock('../src/supervisor/postgres-process.js', () => ({ postgresDocker: mocks.docker }));
vi.mock('../src/core/events.js', () => ({ recordEvent: vi.fn() }));
vi.mock('../src/supervisor/development-backup.js', () => ({
  developmentBackupDependencies: vi.fn(), developmentBackupRuntimeHeld: mocks.held,
}));
import { postgresDevelopmentReplacements, postgresDevelopmentRuntimeHealthy, startPostgresDevelopmentRuntime } from '../src/supervisor/postgres-development-runtime.js';

const owner = { service: 'api', sessionId: 'dev-test', targetId: 'service', name: 'treeseed-dev-test-api-service' };
const image = `sha256:${'a'.repeat(64)}`;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.stat.mockReturnValue({ isFile: () => true, uid: 0, mode: 0o100600 });
  mocks.realpath.mockImplementation((path: string) => path);
  mocks.read.mockReturnValue(JSON.stringify({ services: { runtime: { image, container_name: owner.name } } }));
  mocks.docker.mockResolvedValue(JSON.stringify({ image, state: 'running', health: 'healthy' }));
});
it('uses only active API development selections as replacement authority', () => {
  mocks.sessions.mockReturnValue([
    { session: { status: 'active', sessionId: 'dev-test', targets: [
      { projectId: 'api', targetId: 'service', mode: 'live' },
      { projectId: 'api', targetId: 'operations-runner', mode: 'released' },
      { projectId: 'agent', targetId: 'provider', mode: 'live' },
    ] } },
    { session: { status: 'stopped', targets: [] } },
  ]);
  expect(postgresDevelopmentReplacements('api')).toEqual([owner]);
  expect(postgresDevelopmentReplacements('identity')).toEqual([]);
});
it('accepts the exact healthy root-owned image without consulting a hold', async () => {
  expect(await postgresDevelopmentRuntimeHealthy(owner)).toBe(true);
  expect(mocks.held).not.toHaveBeenCalled();
});
it('rejects mutable custody and mismatched images', async () => {
  mocks.stat.mockReturnValue({ isFile: () => true, uid: 0, mode: 0o100622 });
  await expect(postgresDevelopmentRuntimeHealthy(owner)).rejects.toThrow('root custody');
  expect(mocks.docker).not.toHaveBeenCalled();
  mocks.stat.mockReturnValue({ isFile: () => true, uid: 0, mode: 0o100600 });
  mocks.docker.mockResolvedValue(JSON.stringify({ image: `sha256:${'b'.repeat(64)}`, state: 'running', health: 'healthy' }));
  expect(await postgresDevelopmentRuntimeHealthy(owner)).toBe(false);
});
it('never substitutes a hold for API service health', async () => {
  mocks.docker.mockImplementation(async (args: string[]) => args[0] === 'ps' ? 'a'.repeat(64) : JSON.stringify({ image, state: 'exited', health: 'none' }));
  expect(await postgresDevelopmentRuntimeHealthy(owner)).toBe(false);
  expect(mocks.held).not.toHaveBeenCalled();
});
it('recreates the exact API snapshot to refresh restored credential mounts', async () => {
  await startPostgresDevelopmentRuntime(owner);
  expect(mocks.docker).toHaveBeenCalledWith(['compose', '--project-name', owner.name, '--file',
    '/run/treeseed/development-containers/dev-test/service/compose.json', 'up', '--detach', '--force-recreate',
    '--no-deps', '--wait', '--wait-timeout', '120', 'runtime'], 130);
  await expect(startPostgresDevelopmentRuntime({ ...owner, targetId: 'operations-runner' })).rejects.toThrow('before recovery acceptance');
  expect(mocks.docker).toHaveBeenCalledTimes(1);
});
it('requires a validated restored hold for a stopped operations writer', async () => {
  const runner = { ...owner, service: 'operations-runner', targetId: 'operations-runner', name: 'treeseed-dev-test-api-operations-runner' };
  mocks.read.mockReturnValue(JSON.stringify({ services: { runtime: { image, container_name: runner.name } } }));
  mocks.docker.mockImplementation(async (args: string[]) => args[0] === 'ps' ? 'a'.repeat(64) : JSON.stringify({ image, state: 'exited', health: 'none' }));
  mocks.held.mockReturnValue(false);
  expect(await postgresDevelopmentRuntimeHealthy(runner)).toBe(false);
  mocks.held.mockReturnValue(true);
  expect(await postgresDevelopmentRuntimeHealthy(runner)).toBe(true);
  mocks.docker.mockResolvedValue('');
  expect(await postgresDevelopmentRuntimeHealthy(runner)).toBe(true);
  mocks.held.mockReturnValue(false);
  await expect(postgresDevelopmentRuntimeHealthy(runner)).rejects.toThrow();
});

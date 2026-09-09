import { expect, it } from 'vitest';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { component } from './fixtures.js';
import { runPostgresComponentLifecycle, type PostgresLifecyclePorts } from '../src/postgres/lifecycle.js';

function fixture() {
  const release = component('api', 'stable', 'a');
  release.runtime.services.push({ id: 'migration', composeService: 'migration', endpoints: [] });
  release.runtime.postgresRequirements = [{ id: 'api', supportedMajors: [17], extensions: [], runtimeConnectionLimit: 10 }];
  release.runtime.postgresLifecycle = [{ requirementId: 'api', credentialOwner: { uid: 65532, gid: 65532 }, migration: { composeService: 'migration', completion: 'exit-zero', timeoutSeconds: 120 }, runtimeServices: ['service'] }];
  release.runtimeDigest = deploymentDigest(release.runtime);
  const calls: string[] = [];
  const ports: PostgresLifecyclePorts = {
    accepted: async () => false, verifyRuntime: async () => true, runtimeHealthy: async () => true,
    requireRestorePoint: async () => { calls.push('restore-point'); },
    stopServices: async services => { calls.push(`stop:${services.join(',')}`); },
    ensureCredentials: async id => { calls.push(`ensure:${id}`); },
    activate: async (id, phase) => { calls.push(`activate:${id}:${phase}`); },
    materialize: async (id, phase) => { calls.push(`files:${id}:${phase}`); },
    migrate: async migration => { calls.push(`migrate:${migration.composeService}`); },
    clear: async (id, phase) => { calls.push(`clear:${id}:${phase}`); },
    disable: async id => { calls.push(`disable:${id}`); },
    startRuntime: async services => { calls.push(`start:${services.join(',')}`); },
    record: async () => { calls.push('record'); },
  };
  return { release, ports, calls };
}
it('orders restore, stopped writers, migration cleanup and runtime activation', async () => {
  const { release, ports, calls } = fixture();
  expect((await runPostgresComponentLifecycle(release, 'a'.repeat(64), ports)).action).toBe('activated');
  expect(calls).toEqual(['restore-point', 'stop:service,migration', 'ensure:api', 'activate:api:migration', 'files:api:migration', 'migrate:migration', 'stop:migration', 'clear:api:migration', 'activate:api:runtime', 'files:api:runtime', 'start:service', 'record']);
});
it('leaves verified live runtime untouched', async () => {
  const { release, ports, calls } = fixture(); ports.accepted = async () => true;
  expect((await runPostgresComponentLifecycle(release, 'a'.repeat(64), ports)).action).toBe('noop');
  expect(calls).toEqual([]);
});
it('restarts an accepted stopped runtime without reopening migration access', async () => {
  const { release, ports, calls } = fixture(); ports.accepted = async () => true;
  let checks = 0; ports.runtimeHealthy = async () => checks++ > 0;
  expect((await runPostgresComponentLifecycle(release, 'a'.repeat(64), ports)).action).toBe('restarted');
  expect(calls).toEqual(['files:api:runtime', 'start:service']);
});
it('rejects drift or missing recovery before stopping anything', async () => {
  const { release, ports, calls } = fixture(); ports.accepted = async () => true; ports.verifyRuntime = async () => false;
  await expect(runPostgresComponentLifecycle(release, 'a'.repeat(64), ports)).rejects.toThrow('drift');
  expect(calls).toEqual([]);
  ports.accepted = async () => false; ports.requireRestorePoint = async () => { throw new Error('No recovery'); };
  await expect(runPostgresComponentLifecycle(release, 'a'.repeat(64), ports)).rejects.toThrow('No recovery');
  expect(calls).toEqual([]);
});
it('disables access and clears both phases on migration failure, without recording acceptance', async () => {
  const { release, ports, calls } = fixture(); ports.migrate = async () => { throw new Error('secret provider diagnostics'); };
  await expect(runPostgresComponentLifecycle(release, 'a'.repeat(64), ports)).rejects.toThrow('schema-migration');
  expect(calls).toContain('disable:api'); expect(calls).toContain('clear:api:migration'); expect(calls).toContain('clear:api:runtime');
  expect(calls).not.toContain('start:service'); expect(calls).not.toContain('record');
});

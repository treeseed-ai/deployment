import { expect, it } from 'vitest';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { inspectPostgresSource, postgresSourceInventorySql, type SourceDocker } from '../src/postgres/source-inventory.js';
import { supervisorOperationSchema } from '../src/supervisor/protocol.js';
import { component } from './fixtures.js';

function fixture() {
  const release = component('api', 'development', 'a');
  release.runtime.services[0]!.composeService = 'database';
  release.runtimeDigest = deploymentDigest(release.runtime);
  const selected = { services: { database: { image: `treeseed/api@${release.images[0]!.digest}`,
    environment: { POSTGRES_DB: 'application', POSTGRES_USER: 'owner', POSTGRES_PASSWORD: 'never-return-this' } } } };
  const state = { id: 'b'.repeat(64), image: `sha256:${'c'.repeat(64)}`, configuredImage: selected.services.database.image,
    state: 'running', started: '2026-09-09T00:00:00Z', project: 'treeseed-api', service: 'database' };
  const metadata = { database: 'application', major: 16, cluster: '1234567890123456789',
    locale: { encoding: 'UTF8', collate: 'C', ctype: 'C', provider: 'c', version: null, locale: null } };
  const calls: string[][] = []; let inspection = 0, restarted = false, duplicate = false;
  const docker: SourceDocker = async args => {
    calls.push(args);
    if (args[0] === 'image') return `sha256:${'c'.repeat(64)}`;
    if (args[0] === 'ps') return duplicate ? `${state.id}\n${'d'.repeat(64)}` : state.id;
    if (args[0] === 'inspect') { inspection++; return JSON.stringify({ ...state, ...(restarted && inspection > 1 ? { started: 'later' } : {}) }); }
    if (args[0] === 'exec') return JSON.stringify(metadata);
    throw new Error('unexpected command');
  };
  const run = () => inspectPostgresSource(release, 'database', selected, docker);
  return { release, selected, state, metadata, calls, run, restart: () => { restarted = true; }, duplicate: () => { duplicate = true; } };
}
it('reads only the attested installed source and returns no credentials or raw cluster ID', async () => {
  const f = fixture(), result = await f.run();
  expect(result.major).toBe(16); expect(result.clusterIdentity).toMatch(/^sha256:/u);
  expect(JSON.stringify(result)).not.toContain('never-return-this'); expect(JSON.stringify(result)).not.toContain(f.metadata.cluster);
  expect(f.calls.find(args => args[0] === 'exec')?.at(-1)).toBe(postgresSourceInventorySql);
  expect(postgresSourceInventorySql).toContain('BEGIN READ ONLY');
});
it.each(['state','image','configuredImage','project','service'] as const)('rejects foreign or stopped %s before querying', async field => {
  const f = fixture(); f.state[field] = 'wrong';
  await expect(f.run()).rejects.toThrow('source unchanged'); expect(f.calls.some(args => args[0] === 'exec')).toBe(false);
});
it('rejects ambiguous containers', async () => { const f = fixture(); f.duplicate(); await expect(f.run()).rejects.toThrow('source unchanged'); });
it('rejects a restart during catalog inspection', async () => { const f = fixture(); f.restart(); await expect(f.run()).rejects.toThrow('source unchanged'); });
it('rejects a mismatched database result', async () => { const f = fixture(); f.metadata.database = 'other'; await expect(f.run()).rejects.toThrow('source unchanged'); });
it('rejects a runtime manifest digest mismatch', async () => { const f = fixture(); f.release.runtimeDigest = `sha256:${'0'.repeat(64)}`; await expect(f.run()).rejects.toThrow('source unchanged'); expect(f.calls).toEqual([]); });
it('does not accept caller commands, credentials or addresses', () => {
  const request = { operation: 'postgres.source.inspect', componentId: 'api', release: '1.0.0', serviceId: 'database' };
  expect(supervisorOperationSchema.safeParse(request).success).toBe(true);
  for (const extra of [{ sql: 'SELECT 1' }, { hostname: 'other' }, { password: 'secret' }])
    expect(supervisorOperationSchema.safeParse({ ...request, ...extra }).success).toBe(false);
});

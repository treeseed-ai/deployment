import { beforeEach, expect, it, vi } from 'vitest';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { component, host, hash } from './fixtures.js';
import { activateOrTransferPostgresComponent } from '../src/supervisor/postgres-transfer-execution.js';
const f = vi.hoisted(() => ({ host: vi.fn(), installed: vi.fn(), previous: vi.fn(), selected: vi.fn(), binding: vi.fn(), switch: vi.fn(),
  accept: vi.fn(), backup: vi.fn(), copy: vi.fn(), plan: vi.fn(), save: vi.fn(), data: vi.fn(), activate: vi.fn(),
  healthy: vi.fn(), runtime: vi.fn(), clear: vi.fn(), stop: vi.fn(), writers: vi.fn(), lock: vi.fn(), journal: vi.fn(), events: [] as string[] }));
vi.mock('../src/core/configuration.js', () => ({ loadHostConfiguration: f.host }));
vi.mock('../src/supervisor/component-release.js', () => ({ installedComponentRelease: f.installed }));
vi.mock('../src/supervisor/postgres-transition-custody.js', () => ({ previousPostgresComponent: f.previous,
  postgresTransitionStore: () => ({ selected: f.selected, binding: f.binding, switch: f.switch, accept: f.accept }), privatePostgresState: () => ['source/postgres'] }));
vi.mock('../src/supervisor/postgres-transfer-guard.js', () => ({ postgresTransferJournal: f.journal }));
vi.mock('../src/supervisor/backup.js', () => ({ inspectGenerationBackup: f.backup }));
vi.mock('../src/supervisor/backup-writers.js', () => ({ assertNoBackupWriters: f.writers }));
vi.mock('../src/supervisor/postgres-copy-reader.js', () => ({ withManagedPostgresSourceCopy: f.copy }));
vi.mock('../src/supervisor/postgres-transfer-plan.js', () => ({ planManagedPostgresTransferFromSource: f.plan }));
vi.mock('../src/supervisor/postgres-transfer-data.js', () => ({ managedPostgresTransferData: f.data }));
vi.mock('../src/postgres/transfer-plan-store.js', () => ({ PostgresTransferPlanStore: class { save = f.save; } }));
vi.mock('../src/supervisor/postgres-lifecycle.js', () => ({ activateLocalPostgresComponent: f.activate }));
vi.mock('../src/supervisor/postgres-runtime-health.js', () => ({ postgresComponentRuntimeHealthy: f.healthy }));
vi.mock('../src/supervisor/postgres.js', () => ({ reconcileLocalPostgres: async () => ({ ready: true }) }));
vi.mock('../src/postgres/runtime-state.js', () => ({ verifyPostgresAllocationRuntime: f.runtime }));
vi.mock('../src/postgres/connection.js', () => ({ withLocalPostgresBootstrap: async (_root: unknown, _db: unknown, run: (session: object) => unknown) => run({}) }));
vi.mock('../src/supervisor/component-sealed.js', () => ({ readComponentCredential: () => 'synthetic-only' }));
vi.mock('../src/supervisor/postgres-client-files.js', () => ({ clearPostgresClient: f.clear }));
vi.mock('../src/supervisor/postgres-transfer-service.js', () => ({ retainedPostgresService: async () => 'database' }));
vi.mock('../src/manager/ai-mode.js', () => ({ aiModeActivationServices: () => undefined }));
beforeEach(() => { vi.resetAllMocks(); f.events = []; });
function fixture() {
  const configuration = host(), prior = component('api', 'stable', 'a'), next = component('api', 'development', 'b');
  prior.images[0]!.repository = 'postgres';
  next.runtime.postgresLifecycle = [{ requirementId: 'api', credentialOwner: { uid: 1000, gid: 1000 },
    migration: { composeService: 'migration', completion: 'exit-zero', timeoutSeconds: 120 }, runtimeServices: ['service'] }];
  configuration.postgres = { schemaVersion: 'treeseed.postgres-topology/v1', installationId: 'test', environment: 'staging',
    servers: [], requirements: [], allocations: [{ requirementId: 'api', serverId: 'shared', database: 'api', ownerRole: 'owner',
      migrationRole: 'migrator', runtimeRole: 'runtime', migrationCredentialReference: 'migration', runtimeCredentialReference: 'runtime', onDisable: 'preserve' }] };
  const intent = { installationId: 'test', environment: 'staging', requirementId: 'api', topologyDigest: deploymentDigest(configuration.postgres),
    runtimeDigest: next.runtimeDigest, source: { clusterIdentity: hash('a'), database: 'source', major: 16 },
    destination: { clusterIdentity: hash('b'), database: 'api', major: 17 }, sourceInventoryDigest: hash('c'),
    destinationAllocationDigest: hash('d'), restorePointDigest: hash('e') };
  const plan = { intent, intentDigest: deploymentDigest(intent), planDigest: hash('f'), configurationDigest: deploymentDigest(configuration) };
  const archive = { digest: hash('d'), encrypted: true as const, intentDigest: plan.intentDigest };
  const state = { active: null as null | { stage: string; intentDigest: string }, accepted: false, locked: false,
    binding: null as null | Record<string, unknown> };
  f.lock.mockImplementation(async run => { expect(state.locked).toBe(false); state.locked = true; try { return await run(); } finally { state.locked = false; } });
  f.journal.mockReturnValue({ locked: f.lock, active: () => state.active, accepted: () => state.accepted,
    begin: (record: { intentDigest: string }) => { expect(state.locked).toBe(true); state.active = { ...record, stage: 'fencing' }; },
    advance: (_id: string, stage: string) => { f.events.push(stage); state.active!.stage = stage; if (stage === 'accepted') { state.accepted = true; state.active = null; } } });
  f.host.mockReturnValue(configuration); f.installed.mockReturnValue(next); f.previous.mockReturnValue(prior);
  f.binding.mockImplementation(() => state.binding); f.selected.mockReturnValue({ allowLocaleConversion: false });
  f.switch.mockImplementation(record => { state.binding = { ...record, version: 1, state: 'switched' }; return { bindingDigest: deploymentDigest(state.binding) }; });
  f.accept.mockImplementation(() => { f.events.push('binding-accepted'); state.binding = { ...state.binding, version: 2, state: 'accepted' }; });
  f.backup.mockResolvedValue({ sha256: 'e'.repeat(64) });
  f.stop.mockImplementation(async () => { f.events.push('helper-stopped'); });
  f.copy.mockImplementation(async (_selection, run) => run({ stop: f.stop,
    read: async () => ({ source: { runtimeDigest: prior.runtimeDigest }, backupDigest: hash('e'), backupGeneration: 7 }) }));
  f.plan.mockResolvedValue(plan);
  const data = { revalidate: vi.fn(async () => true), writersFenced: vi.fn(async () => true), sourceFenced: vi.fn(async () => true),
    destinationEmpty: vi.fn(async () => true), fence: vi.fn(async () => undefined), export: vi.fn(async () => archive),
    restore: vi.fn(async () => undefined), verify: vi.fn(async () => true) };
  f.data.mockReturnValue(data); f.healthy.mockResolvedValue(true); f.runtime.mockResolvedValue({ verified: true });
  f.activate.mockImplementation(async () => { expect(state.locked).toBe(true); return { action: 'noop' }; });
  const run = (backup: number | undefined = 7) => activateOrTransferPostgresComponent('api', [{ componentId: 'api', release: next.release }], backup);
  return { state, prior, next, plan, data, run };
}
it('holds one OS lock through copy, transfer, binding CAS, activation and helper cleanup', async () => {
  const v = fixture(); expect((await v.run()).action).toBe('transferred');
  expect(f.lock).toHaveBeenCalledTimes(1); expect(v.state.locked).toBe(false); expect(v.state.active).toBeNull();
  expect(f.events).toEqual(['export', 'restore', 'verify', 'switch', 'activate', 'helper-stopped', 'binding-accepted', 'accepted']);
  expect(v.state.binding?.state).toBe('accepted'); expect(f.save).toHaveBeenCalledTimes(1);
  expect(f.activate.mock.calls[0]![3]).toEqual(v.plan.intent);
});
it.each(['verification', 'runtime', 'cleanup'] as const)('retains the recovery hold after %s failure', async failure => {
  const v = fixture();
  if (failure === 'verification') v.data.verify.mockResolvedValue(false);
  if (failure === 'runtime') f.healthy.mockResolvedValue(false);
  if (failure === 'cleanup') f.stop.mockRejectedValue(new Error('unavailable'));
  await expect(v.run()).rejects.toThrow('recovery');
  expect(v.state.active?.stage).toBe('recovery-required'); expect(v.state.accepted).toBe(false); expect(f.accept).not.toHaveBeenCalled();
  expect(v.data.fence).toHaveBeenCalledTimes(2);
});
it('rejects missing exact preparation before opening the source helper', async () => {
  const v = fixture(); f.selected.mockImplementation(() => { throw new Error('exact selection required'); });
  await expect(v.run()).rejects.toThrow('exact selection'); expect(f.copy).not.toHaveBeenCalled(); expect(f.switch).not.toHaveBeenCalled();
});
it('replays an accepted binding without copying or requiring the retained backup again', async () => {
  const v = fixture(); await v.run(); f.copy.mockClear(); f.activate.mockClear();
  expect((await activateOrTransferPostgresComponent('api', [{ componentId: 'api', release: v.next.release }])).action).toBe('noop');
  expect(f.copy).not.toHaveBeenCalled(); expect(f.activate).toHaveBeenCalledTimes(1); expect(f.writers).toHaveBeenCalled();
});

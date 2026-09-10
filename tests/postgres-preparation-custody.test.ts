import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { component, host } from './fixtures.js';
import { prepareLocalPostgresTransition } from '../src/supervisor/postgres-transition-custody.js';
const f = vi.hoisted(() => ({ host: vi.fn(), read: vi.fn(), store: vi.fn(), prepare: vi.fn(), held: false }));
vi.mock('../src/core/configuration.js', () => ({ loadHostConfiguration: f.host }));
vi.mock('node:fs', async original => ({ ...await original<object>(), existsSync: () => true, readFileSync: f.read }));
vi.mock('../src/postgres/transition-store.js', () => ({ PostgresTransitionStore: class { constructor() { f.store(); } prepare = f.prepare; } }));
vi.mock('../src/supervisor/postgres-transfer-guard.js', () => ({ postgresTransferJournal: () => ({ locked: async (run: () => Promise<unknown>) => run(), active: () => f.held ? {} : null }) }));
beforeEach(() => { vi.resetAllMocks(); f.held = false; vi.spyOn(process, 'getuid').mockReturnValue(0); });
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const configuration = host(), previous = component('api', 'stable', 'a');
  configuration.components.postgres = { ...configuration.components.api! };
  previous.runtime.stateVolumes = [{ id: 'postgres', volume: '/var/lib/treeseed/components/api/postgres', backup: 'required' }];
  previous.runtimeDigest = deploymentDigest(previous.runtime);
  f.host.mockReturnValue(configuration); f.read.mockImplementation(() => JSON.stringify([previous]));
  const selection = { componentId: 'api', sourceRuntimeDigest: previous.runtimeDigest, targetRuntimeDigest: `sha256:${'b'.repeat(64)}`,
    topologyDigest: `sha256:${'c'.repeat(64)}`, configurationDigest: `sha256:${'d'.repeat(64)}`, allowLocaleConversion: false };
  return { configuration, previous, selection };
}
it('plans against current source without opening or writing preparation custody', async () => {
  const fxt = fixture();
  expect(await prepareLocalPostgresTransition(fxt.selection, true)).toEqual({ action: 'planned', selectionDigest: deploymentDigest(fxt.selection) });
  expect(f.store).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
});
it('writes only the exact validated selection on apply', async () => {
  const fxt = fixture(); f.prepare.mockReturnValue({ action: 'prepared' }); await prepareLocalPostgresTransition(fxt.selection);
  expect(f.prepare).toHaveBeenCalledExactlyOnceWith(fxt.selection);
});
it('rejects stale source and active recovery before writing', async () => {
  const fxt = fixture(); fxt.previous.runtime.version = 'changed';
  await expect(prepareLocalPostgresTransition(fxt.selection)).rejects.toThrow();
  f.held = true; await expect(prepareLocalPostgresTransition(fxt.selection, true)).rejects.toThrow('recovery');
  expect(f.store).not.toHaveBeenCalled();
});

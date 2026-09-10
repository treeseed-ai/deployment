import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { PostgresTransferJournal } from '../src/postgres/transfer-journal.js';
import { journaledPostgresTransfer } from '../src/postgres/journaled-transfer.js';
import { transferPostgresDatabase, type PostgresTransferIntent, type PostgresTransferPorts } from '../src/postgres/transfer.js';
import { guardPostgresTransferOperation } from '../src/supervisor/postgres-transfer-guard.js';
import type { SupervisorOperation } from '../src/supervisor/protocol.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'treeseed-journaled-transfer-')); roots.push(root);
  const journal = new PostgresTransferJournal(root); let accepted = false;
  const intent: PostgresTransferIntent = { installationId: 'fixture', environment: 'staging', requirementId: 'api',
    topologyDigest: digest('a'), runtimeDigest: digest('b'), sourceInventoryDigest: digest('c'),
    destinationAllocationDigest: digest('d'), restorePointDigest: digest('e'),
    source: { clusterIdentity: digest('a'), database: 'api', major: 16 },
    destination: { clusterIdentity: digest('b'), database: 'api', major: 17 } };
  const stages: Array<string | undefined> = [];
  const ports: PostgresTransferPorts = {
    withLock: async (_intent, run) => run(), revalidate: async () => true, accepted: async () => accepted,
    bindingMatches: async () => true, runtimeHealthy: async () => true, verifyRestorePoint: async () => true,
    fenceWriters: async () => { stages.push(journal.active()?.stage); }, writersFenced: async () => true,
    destinationEmpty: async () => true,
    exportEncrypted: async (_intent, intentDigest) => { stages.push(journal.active()?.stage); return { intentDigest, digest: digest('f'), encrypted: true }; },
    restoreOwnedEmptyDestination: async () => { stages.push(journal.active()?.stage); },
    verifyTransfer: async () => { stages.push(journal.active()?.stage); return true; },
    switchBinding: async () => { stages.push(journal.active()?.stage); },
    activateDestination: async () => { stages.push(journal.active()?.stage); },
    sourceFenced: async () => true, clearTransientCredentials: async () => undefined,
    recordAccepted: async () => { accepted = true; },
  };
  const run = () => transferPostgresDatabase(intent, deploymentDigest(intent), journaledPostgresTransfer(ports, journal, { generation: 123, digest: digest('e') }));
  return { root, journal, intent, ports, run, stages };
}
it('journals every mutating phase before executing it and replays as noop', async () => {
  const f = fixture(); expect((await f.run()).action).toBe('transferred');
  expect(f.stages).toEqual(['fencing','export','restore','verify','switch','activate']);
  expect(f.journal.active()).toBeNull(); expect((await f.run()).action).toBe('noop');
});
it.each(['fenceWriters','exportEncrypted','restoreOwnedEmptyDestination','switchBinding','activateDestination','recordAccepted'] as const)('retains recovery hold after %s fails', async operation => {
  const f = fixture(); f.ports[operation] = async () => { throw new Error('private driver output'); };
  await expect(f.run()).rejects.toThrow('PostgreSQL transfer failed');
  expect(f.journal.active()?.stage).toBe('recovery-required');
  await expect(f.run()).rejects.toThrow('explicit state read-back');
});
it('does not create a hold for failed preflight or wrong restore identity', async () => {
  const f = fixture(); f.ports.verifyRestorePoint = async () => false;
  await expect(f.run()).rejects.toThrow('restore point'); expect(f.journal.active()).toBeNull();
  f.intent.restorePointDigest = digest('f');
  await expect(f.run()).rejects.toThrow('inspection or lock'); expect(f.journal.active()).toBeNull();
});
it('blocks writer activation and manager replacement while permitting containment/status', () => {
  const f = fixture(); f.journal.begin({ intentDigest: deploymentDigest(f.intent), restoreGeneration: 123, restoreDigest: digest('e') });
  const marker = join(f.root, 'active.json');
  for (const operation of ['compose.activate','component.configure','postgres.apply','configuration.replace','development.boot.resume','host.development.deactivate'])
    expect(() => guardPostgresTransferOperation({ operation } as SupervisorOperation, marker)).toThrow('holds');
  expect(() => guardPostgresTransferOperation({ operation: 'apt.install', packages: ['treeseed-manager=1.0.0'] }, marker)).toThrow('holds');
  expect(() => guardPostgresTransferOperation({ operation: 'apt.install', packages: ['treeseed-postgres=1.0.0', 'treeseed-identity=1.0.0'] }, marker)).not.toThrow();
  for (const operation of ['compose.stop','postgres.transfer.status','backup.inspect','recovery.restore'])
    expect(() => guardPostgresTransferOperation({ operation } as SupervisorOperation, marker)).not.toThrow();
});

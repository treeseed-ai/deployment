import { expect, it } from 'vitest';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { transferPostgresDatabase, type PostgresTransferIntent, type PostgresTransferPorts } from '../src/postgres/transfer.js';

const hash = (letter: string) => `sha256:${letter.repeat(64)}`;
function fixture() {
  const intent: PostgresTransferIntent = {
    installationId: 'fixture', environment: 'staging', requirementId: 'api',
    topologyDigest: hash('a'), runtimeDigest: hash('b'), sourceInventoryDigest: hash('c'),
    destinationAllocationDigest: hash('d'), restorePointDigest: hash('e'),
    source: { clusterIdentity: hash('a'), database: 'api', major: 16 },
    destination: { clusterIdentity: hash('b'), database: 'api', major: 17 },
  };
  const calls: string[] = [];
  const ports: PostgresTransferPorts = {
    withLock: async (_intent, run) => { calls.push('lock'); try { return await run(); } finally { calls.push('unlock'); } },
    revalidate: async () => { calls.push('revalidate'); return true; },
    accepted: async () => false,
    bindingMatches: async () => true, runtimeHealthy: async () => true, sourceFenced: async () => true,
    verifyRestorePoint: async () => { calls.push('recovery'); return true; },
    fenceWriters: async () => { calls.push('fence'); }, writersFenced: async () => true,
    destinationEmpty: async () => { calls.push('empty'); return true; },
    exportEncrypted: async (_intent, intentDigest) => { calls.push('export'); return { digest: hash('f'), encrypted: true, intentDigest }; },
    restoreOwnedEmptyDestination: async () => { calls.push('restore'); },
    verifyTransfer: async () => { calls.push('verify'); return true; },
    switchBinding: async () => { calls.push('switch'); },
    activateDestination: async () => { calls.push('activate'); },
    clearTransientCredentials: async () => { calls.push('clear'); },
    recordAccepted: async () => { calls.push('record'); },
  };
  return { intent, ports, calls, run: () => transferPostgresDatabase(intent, deploymentDigest(intent), ports) };
}

it('orders logical transfer without starting the source or deleting data', async () => {
  const { run, calls } = fixture();
  expect((await run()).action).toBe('transferred');
  expect(calls).toEqual(['lock', 'revalidate', 'recovery', 'empty', 'fence', 'revalidate', 'empty', 'export', 'restore', 'verify', 'switch', 'activate', 'clear', 'record', 'unlock']);
});
it('rejects moved plan bindings before invoking privileged ports', async () => {
  const { intent, ports, calls } = fixture(); const expected = deploymentDigest(intent); intent.environment = 'production';
  await expect(transferPostgresDatabase(intent, expected, ports)).rejects.toThrow('Exact'); expect(calls).toEqual([]);
});
it.each(['same-database', 'downgrade', 'unknown-field'])('rejects %s intents', async mode => {
  const { intent, ports, calls } = fixture();
  if (mode === 'same-database') intent.destination = { ...intent.source };
  if (mode === 'downgrade') { intent.source.major = 17; intent.destination.major = 16; }
  const input = mode === 'unknown-field' ? { ...intent, password: 'never accepted' } : intent;
  await expect(transferPostgresDatabase(input, deploymentDigest(input), ports)).rejects.toThrow(); expect(calls).toEqual([]);
});
it.each(['revalidate', 'verifyRestorePoint', 'destinationEmpty'] as const)('refuses %s before stopping writers', async port => {
  const { run, ports, calls } = fixture(); ports[port] = async () => false;
  await expect(run()).rejects.toThrow(); expect(calls).not.toContain('fence'); expect(calls.at(-1)).toBe('unlock');
});
it('requires emptiness after fencing and never restores over raced data', async () => {
  const { run, ports, calls } = fixture(); let reads = 0; ports.destinationEmpty = async () => ++reads === 1;
  await expect(run()).rejects.toThrow('fence-writers'); expect(calls).not.toContain('export'); expect(calls).toContain('clear');
});
it.each(['fenceWriters', 'exportEncrypted', 'restoreOwnedEmptyDestination', 'switchBinding', 'activateDestination', 'clearTransientCredentials', 'recordAccepted'] as const)('contains %s failure and redacts driver diagnostics', async port => {
  const { run, ports, calls } = fixture(); ports[port] = async () => { throw new Error('secret-driver-payload'); };
  await expect(run()).rejects.toThrow(/PostgreSQL transfer failed/);
  expect(calls.at(-1)).toBe('unlock'); expect(calls).not.toContain('record');
});
it.each(['writersFenced', 'verifyTransfer', 'bindingMatches', 'runtimeHealthy', 'sourceFenced'] as const)('rejects failed %s read-back', async port => {
  const { run, ports, calls } = fixture(); ports[port] = async () => false;
  await expect(run()).rejects.toThrow('PostgreSQL transfer failed'); expect(calls).not.toContain('record');
});
it('rejects an encrypted archive from another exact intent', async () => {
  const { run, ports, calls } = fixture(); ports.exportEncrypted = async () => ({ digest: hash('f'), encrypted: true, intentDigest: hash('a') });
  await expect(run()).rejects.toThrow('encrypted-export'); expect(calls).not.toContain('restore');
});
it.each(['revalidate', 'accepted', 'verifyRestorePoint', 'destinationEmpty'] as const)('redacts %s inspection exceptions', async port => {
  const { run, ports, calls } = fixture(); ports[port] = async () => { throw new Error('secret-driver-payload'); };
  await expect(run()).rejects.toThrow('inspection or lock failed'); expect(calls).not.toContain('fence');
});
it('replays only accepted healthy bindings with the source still fenced', async () => {
  const { run, ports, calls } = fixture(); ports.accepted = async () => true;
  expect((await run()).action).toBe('noop'); expect(calls).toEqual(['lock', 'revalidate', 'unlock']);
  ports.sourceFenced = async () => false;
  await expect(run()).rejects.toThrow('explicit recovery'); expect(calls).not.toContain('export');
});

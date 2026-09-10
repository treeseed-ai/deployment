import { z } from 'zod';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { postgresLocaleConversionSchema } from './transfer-locale.js';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);
const endpoint = z.object({
  // Catalog-attested cluster identity, not a caller-selected network address.
  clusterIdentity: digest, database: identifier, major: z.number().int().min(16).max(17),
}).strict();
export const postgresTransferIntentSchema = z.object({
  installationId: z.string().min(1).max(128), environment: z.enum(['staging', 'production']),
  requirementId: z.string().min(1).max(128), topologyDigest: digest, runtimeDigest: digest,
  source: endpoint, destination: endpoint,
  sourceInventoryDigest: digest, destinationAllocationDigest: digest,
  restorePointDigest: digest,
  localeConversion: postgresLocaleConversionSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.source.clusterIdentity === value.destination.clusterIdentity && value.source.database === value.destination.database)
    context.addIssue({ code: 'custom', message: 'Distinct PostgreSQL databases required' });
  if (value.source.major > value.destination.major)
    context.addIssue({ code: 'custom', message: 'PostgreSQL major downgrade is not supported' });
});

export type PostgresTransferIntent = z.infer<typeof postgresTransferIntentSchema>;
export interface PostgresTransferArchive { digest: string; encrypted: true; intentDigest: string }
class TransferFailure extends Error {}

/** Internal coordinator, not a public wire contract. A fixed privileged adapter
 * supplies these ports from installed manifests and OS custody. In particular,
 * locks must also exclude normal lifecycle activation and other transfer intents.
 * No caller commands, connection strings or plaintext archives cross this boundary.
 */
export interface PostgresTransferPorts {
  withLock<T>(intent: PostgresTransferIntent, run: () => Promise<T>): Promise<T>;
  // Verify installation/environment, source catalog and destination allocation
  // custody against the exact intent; same-named resources are not sufficient.
  revalidate(intent: PostgresTransferIntent): Promise<boolean>;
  accepted(intentDigest: string): Promise<boolean>;
  bindingMatches(intent: PostgresTransferIntent): Promise<boolean>;
  runtimeHealthy(intent: PostgresTransferIntent): Promise<boolean>;
  verifyRestorePoint(intent: PostgresTransferIntent): Promise<boolean>;
  fenceWriters(intent: PostgresTransferIntent): Promise<void>;
  writersFenced(intent: PostgresTransferIntent): Promise<boolean>;
  destinationEmpty(intent: PostgresTransferIntent): Promise<boolean>;
  exportEncrypted(intent: PostgresTransferIntent, intentDigest: string): Promise<PostgresTransferArchive>;
  restoreOwnedEmptyDestination(intent: PostgresTransferIntent, archive: PostgresTransferArchive): Promise<void>;
  verifyTransfer(intent: PostgresTransferIntent, archive: PostgresTransferArchive): Promise<boolean>;
  // Compare-and-swap from the captured source binding; no credentials in receipt.
  switchBinding(intent: PostgresTransferIntent): Promise<void>;
  // Existing component lifecycle, including migration and restricted runtime roles.
  activateDestination(intent: PostgresTransferIntent): Promise<void>;
  sourceFenced(intent: PostgresTransferIntent): Promise<boolean>;
  clearTransientCredentials(intent: PostgresTransferIntent): Promise<void>;
  recordAccepted(intentDigest: string, archiveDigest: string): Promise<void>;
}

export async function transferPostgresDatabase(input: unknown, expectedDigest: string, ports: PostgresTransferPorts) {
  const intent = postgresTransferIntentSchema.parse(input);
  const intentDigest = deploymentDigest(intent);
  if (expectedDigest !== intentDigest) throw new Error('Exact PostgreSQL transfer intent required');
  return ports.withLock(intent, async () => {
    if (!await ports.revalidate(intent)) throw new TransferFailure('PostgreSQL transfer inventory is stale or unowned');
    if (await ports.accepted(intentDigest)) {
      if (!await ports.bindingMatches(intent) || !await ports.runtimeHealthy(intent) || !await ports.sourceFenced(intent))
        throw new TransferFailure('Accepted PostgreSQL transfer requires explicit recovery');
      return { action: 'noop' as const, intentDigest };
    }
    if (!await ports.verifyRestorePoint(intent)) throw new TransferFailure('Coordinated PostgreSQL restore point required');
    if (!await ports.destinationEmpty(intent)) throw new TransferFailure('PostgreSQL transfer destination is not empty');
    let stage = 'fence-writers';
    try {
      await ports.fenceWriters(intent);
      if (!await ports.writersFenced(intent)) throw new Error();
      // Repeat after fencing: preflight emptiness cannot authorize overwrite.
      if (!await ports.revalidate(intent) || !await ports.destinationEmpty(intent)) throw new Error();
      stage = 'encrypted-export';
      const archive = await ports.exportEncrypted(intent, intentDigest);
      if (archive.encrypted !== true || archive.intentDigest !== intentDigest || !digest.safeParse(archive.digest).success) throw new Error();
      stage = 'logical-restore';
      await ports.restoreOwnedEmptyDestination(intent, archive);
      stage = 'transfer-verification';
      if (!await ports.verifyTransfer(intent, archive) || !await ports.writersFenced(intent)) throw new Error();
      stage = 'binding-switch';
      await ports.switchBinding(intent);
      if (!await ports.bindingMatches(intent)) throw new Error();
      stage = 'destination-activation';
      await ports.activateDestination(intent);
      if (!await ports.runtimeHealthy(intent) || !await ports.sourceFenced(intent)) throw new Error();
      stage = 'credential-cleanup';
      await ports.clearTransientCredentials(intent);
      stage = 'acceptance';
      await ports.recordAccepted(intentDigest, archive.digest);
      return { action: 'transferred' as const, intentDigest, archiveDigest: archive.digest };
    } catch (error) {
      const lifecycleStage = error instanceof Error
        ? /^PostgreSQL component activation failed \(([a-z-]+)\)/u.exec(error.message)?.[1] : undefined;
      const locations = error instanceof Error ? [...(error.stack ?? '').matchAll(/\/(src\/[a-zA-Z0-9_./-]+\.[jt]s:\d+:\d+)/gu)].slice(0, 6).map(match => match[1]) : [];
      // Even a partially successful stop/switch/record is uncertain. Never restart
      // the source or delete either database as an implicit rollback.
      let cleanupFailed = false;
      try { await ports.fenceWriters(intent); if (!await ports.writersFenced(intent)) cleanupFailed = true; }
      catch { cleanupFailed = true; }
      try { await ports.clearTransientCredentials(intent); } catch { cleanupFailed = true; }
      throw Object.assign(new TransferFailure(`PostgreSQL transfer failed (${stage}); ${cleanupFailed ? 'containment requires recovery' : 'writers fenced; explicit coordinated recovery required'}. Source data retained.`), { diagnostic: { lifecycleStage, locations, processReason: postgresProcessReason(error) } });
    }
  }).catch((error: unknown) => {
    if (error instanceof TransferFailure) throw error;
    throw new Error('PostgreSQL transfer inspection or lock failed; explicit state read-back required.');
  });
}
import { postgresProcessReason } from './transfer-diagnostic.js';

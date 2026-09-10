import { deploymentDigest } from '@treeseed/sdk/deployment';
import type { PostgresTransferPorts } from './transfer.js';
import type { PostgresTransferJournal } from './transfer-journal.js';

/** Internal adapter decoration. The owner supplies a verified restore point,
 * concrete installed-runtime operations, and the durable root-owned journal.
 * Never expose these ports or recovery metadata as caller-supplied callbacks.
 */
export function journaledPostgresTransfer(ports: PostgresTransferPorts, journal: PostgresTransferJournal,
  restorePoint: { generation: number; digest: string }): PostgresTransferPorts {
  return {
    ...journaledPostgresTransferPhases(ports, journal, restorePoint),
    withLock: (intent, run) => ports.withLock(intent, () => journal.locked(async () => {
      if (intent.restorePointDigest !== restorePoint.digest) throw new Error('Coordinated restore identity changed');
      if (journal.active()) throw new Error('Interrupted PostgreSQL transfer requires coordinated recovery');
      return run();
    })),
  };
}

/** Internal phase decoration for the root coordinator that already owns the
 * journal OS lock while creating and attesting its isolated source helper. */
export function journaledPostgresTransferPhases(ports: PostgresTransferPorts, journal: PostgresTransferJournal,
  restorePoint: { generation: number; digest: string }): PostgresTransferPorts {
  return {
    ...ports,
    accepted: async id => journal.accepted(id) && await ports.accepted(id),
    fenceWriters: async intent => {
      const intentDigest = deploymentDigest(intent);
      if (journal.active()) journal.advance(intentDigest, 'recovery-required');
      else journal.begin({ intentDigest, restoreGeneration: restorePoint.generation, restoreDigest: restorePoint.digest });
      await ports.fenceWriters(intent);
    },
    exportEncrypted: async (intent, id) => {
      journal.advance(id, 'export');
      return ports.exportEncrypted(intent, id);
    },
    restoreOwnedEmptyDestination: async (intent, archive) => {
      journal.advance(deploymentDigest(intent), 'restore', archive.digest);
      await ports.restoreOwnedEmptyDestination(intent, archive);
    },
    verifyTransfer: async (intent, archive) => {
      journal.advance(deploymentDigest(intent), 'verify');
      return ports.verifyTransfer(intent, archive);
    },
    switchBinding: async intent => {
      journal.advance(deploymentDigest(intent), 'switch');
      await ports.switchBinding(intent);
    },
    activateDestination: async intent => {
      journal.advance(deploymentDigest(intent), 'activate');
      await ports.activateDestination(intent);
    },
    recordAccepted: async (id, archive) => {
      await ports.recordAccepted(id, archive);
      journal.advance(id, 'accepted', archive);
    },
  };
}

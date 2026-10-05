import { deploymentDigest } from '@treeseed/sdk/deployment';
import { loadHostConfiguration } from '../core/configuration.js';
import { postgresTransferJournalRoot } from '../core/postgres-transfer-hold.js';
import { transferPostgresDatabase, type PostgresTransferPorts } from '../postgres/transfer.js';
import { journaledPostgresTransferPhases } from '../postgres/journaled-transfer.js';
import { PostgresTransferPlanStore } from '../postgres/transfer-plan-store.js';
import { withLocalPostgresBootstrap } from '../postgres/connection.js';
import { verifyPostgresAllocationRuntime } from '../postgres/runtime-state.js';
import { aiModeActivationServices } from '../manager/ai-mode.js';
import { inspectGenerationBackup } from './backup.js';
import { assertNoBackupWriters } from './backup-writers.js';
import { installedComponentRelease } from './component-release.js';
import { readComponentCredential } from './component-sealed.js';
import { clearPostgresClient } from './postgres-client-files.js';
import { withManagedPostgresSourceCopy } from './postgres-copy-reader.js';
import { planManagedPostgresTransferFromSource } from './postgres-transfer-plan.js';
import { managedPostgresTransferData } from './postgres-transfer-data.js';
import { postgresTransferJournal } from './postgres-transfer-guard.js';
import { postgresTransitionStore, previousPostgresComponent, privatePostgresState } from './postgres-transition-custody.js';
import { activateLocalPostgresComponent } from './postgres-lifecycle.js';
import { postgresComponentRuntimeHealthy } from './postgres-runtime-health.js';
import { reconcileLocalPostgres } from './postgres.js';
import { cleanupPostgresSourceCopies } from './postgres-copy-cleanup.js';

/** Normal component activation enters here after the manager has stopped all
 * generation writers and captured its coordinated backup. Exact preparation
 * is required for existing private data, including explicit locale conversion.
 * No arbitrary connection settings or commands enter this root transaction. */
export async function activateOrTransferPostgresComponent(componentId: string,
  selections: Array<{ componentId: string; release: string }>, backupGeneration?: number) {
  const journal = postgresTransferJournal();
  return journal.locked(async () => {
    if (journal.active()) throw new Error('Interrupted PostgreSQL transfer requires coordinated recovery');
    await cleanupPostgresSourceCopies();
    const host = loadHostConfiguration(), selected = selections.filter(item => item.componentId === componentId);
    if (selected.length !== 1) throw new Error('Exact component selection required');
    const component = installedComponentRelease(componentId, selected[0]!.release), previous = previousPostgresComponent(componentId);
    const privateSource = previous && !previous.runtime.postgresLifecycle?.length &&
      previous.images.some(image => image.role === 'postgres');
    if (!privateSource) return activateLocalPostgresComponent(componentId, selections, backupGeneration);
    if (!host.postgres || component.runtime.postgresLifecycle?.length !== 1)
      throw new Error('Coordinated PostgreSQL transition required; source retained');
    const requirementId = component.runtime.postgresLifecycle[0]!.requirementId, store = postgresTransitionStore(host);
    const binding = store.binding(componentId);
    if (binding) {
      if (binding.state !== 'accepted' || !journal.accepted(binding.intentDigest) || binding.sourceRuntimeDigest !== previous.runtimeDigest ||
        binding.targetRuntimeDigest !== component.runtimeDigest || binding.topologyDigest !== deploymentDigest(host.postgres))
        throw new Error('PostgreSQL binding requires coordinated recovery');
      assertNoBackupWriters(privatePostgresState(host, previous));
      return activateLocalPostgresComponent(componentId, selections, backupGeneration);
    }
    if (backupGeneration === undefined) throw new Error('Coordinated PostgreSQL backup required before transfer');
    const prepared = store.selected({ componentId, sourceRuntimeDigest: previous.runtimeDigest,
      targetRuntimeDigest: component.runtimeDigest, topologyDigest: deploymentDigest(host.postgres), configurationDigest: deploymentDigest(host) });
    const backup = await inspectGenerationBackup(backupGeneration);
    const selection = { componentId, serviceId: '', requirementId, generation: backupGeneration,
      backupDigest: `sha256:${backup.sha256}`, allowLocaleConversion: prepared.allowLocaleConversion, selections };
    // Retained Compose metadata is inspected by the source adapter. Select the
    // old service using only its published PostgreSQL image and Compose config.
    const { retainedPostgresService } = await import('./postgres-transfer-service.js');
    selection.serviceId = await retainedPostgresService(previous);
    assertNoBackupWriters(privatePostgresState(host, previous));
    const allocationPlan = await reconcileLocalPostgres(selections);
    if (!('ready' in allocationPlan) || !allocationPlan.ready) throw new Error('PostgreSQL allocations are blocked');
    await reconcileLocalPostgres(selections, allocationPlan);
    return withManagedPostgresSourceCopy(selection, async source => {
      const initial = await source.read();
      if (initial.source.runtimeDigest !== previous.runtimeDigest) throw new Error('Archived source runtime changed');
      const plan = await planManagedPostgresTransferFromSource(selection, initial), data = managedPostgresTransferData(selection, plan, source.read);
      new PostgresTransferPlanStore(`${postgresTransferJournalRoot}/plans`).save({ selection, plan });
      const migrations = new Set(component.runtime.postgresLifecycle!.map(item => item.migration.composeService));
      const selectedRuntime = () => (aiModeActivationServices(component) ?? component.runtime.services.map(item => item.composeService)).filter(id => !migrations.has(id));
      const modeDigest = deploymentDigest(selectedRuntime());
      const unchanged = () => {
        if (deploymentDigest(loadHostConfiguration()) !== plan.configurationDigest || deploymentDigest(selectedRuntime()) !== modeDigest)
          throw new Error('Host or AI selection changed during PostgreSQL transfer');
      };
      const bound = { componentId, requirementId, sourceRuntimeDigest: previous.runtimeDigest,
        targetRuntimeDigest: component.runtimeDigest, topologyDigest: plan.intent.topologyDigest,
        planDigest: plan.planDigest, intentDigest: plan.intentDigest };
      let switchedDigest: string | undefined;
      const allocation = host.postgres!.allocations.find(item => item.requirementId === requirementId)!;
      const ports: PostgresTransferPorts = {
        withLock: async (_intent, run) => { unchanged(); return run(); }, // Outer journal OS lock spans helper lifetime.
        revalidate: async () => { unchanged(); return data.revalidate(); },
        accepted: async () => false,
        bindingMatches: async () => { unchanged(); const value = store.binding(componentId); return value !== null &&
          value.state === 'switched' && value.version === 1 && deploymentDigest(value) === switchedDigest; },
        runtimeHealthy: async () => {
          unchanged();
          const verified = await withLocalPostgresBootstrap('/run/treeseed/postgres/socket', allocation.database,
            session => verifyPostgresAllocationRuntime(host.postgres!, requirementId, readComponentCredential(host, allocation.runtimeCredentialReference), session));
          return verified.verified && await postgresComponentRuntimeHealthy(component, selectedRuntime());
        },
        verifyRestorePoint: async () => initial.backupDigest === plan.intent.restorePointDigest && initial.backupGeneration === backupGeneration,
        fenceWriters: async () => { unchanged(); await data.fence(); }, writersFenced: data.writersFenced,
        destinationEmpty: data.destinationEmpty, exportEncrypted: data.export,
        restoreOwnedEmptyDestination: async (_intent, archive) => data.restore(archive),
        verifyTransfer: data.verify,
        switchBinding: async () => { unchanged(); switchedDigest = store.switch(bound).bindingDigest; },
        activateDestination: async () => { unchanged(); await activateLocalPostgresComponent(componentId, selections, backupGeneration, plan.intent); },
        sourceFenced: data.sourceFenced,
        clearTransientCredentials: async () => { clearPostgresClient(componentId, requirementId, 'migration'); await source.stop(); },
        recordAccepted: async () => { unchanged(); if (!switchedDigest) throw new Error('Missing binding CAS'); store.accept(componentId, switchedDigest); },
      };
      return transferPostgresDatabase(plan.intent, plan.intentDigest,
        journaledPostgresTransferPhases(ports, journal, { generation: backupGeneration, digest: selection.backupDigest }));
    });
  });
}

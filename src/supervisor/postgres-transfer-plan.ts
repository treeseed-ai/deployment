import { deploymentDigest } from '@treeseed/sdk/deployment';
import { postgresLocaleConversionSchema } from '../postgres/transfer-locale.js';
import { inspectPostgresSourceNetworks } from '../postgres/transfer-fence.js';
import type { PostgresTransferIntent } from '../postgres/transfer.js';
import { componentStateRoot } from './component.js';
import { inspectManagedPostgresDestination } from './postgres-destination.js';
import { inspectRecoveryPostgresSource } from './postgres-source-backup.js';
import { postgresDocker } from './postgres-process.js';

export interface ManagedPostgresTransferSelection {
  componentId:string; serviceId:string; requirementId:string;
  generation:number; backupDigest:string; allowLocaleConversion:boolean;
  selections:Array<{componentId:string;release:string}>;
}

/** Read-only exact plan. Source custody comes from the authenticated coordinated
 * backup; target custody comes from the installed immutable component inventory.
 * No addresses, SQL, credential material, paths or invented database names are
 * accepted. Actual execution must revalidate and fence before export.
 */
export async function planManagedPostgresTransfer(selection:ManagedPostgresTransferSelection) {
  const source=await inspectRecoveryPostgresSource(selection.generation,selection.backupDigest,selection.componentId,selection.serviceId);
  const target=await inspectManagedPostgresDestination(selection.selections,selection.requirementId);
  if(target.component.componentId!==selection.componentId || !target.destination.empty ||
    target.component.runtime.postgresLifecycle?.length!==1 ||
    target.component.runtime.postgresLifecycle[0]?.requirementId!==selection.requirementId)
    throw new Error('Exactly one matching empty destination allocation is required');
  if(!source.coveredState.includes(`${componentStateRoot(target.host,'postgres')}/postgres`.slice(1)))
    throw new Error('Coordinated restore point must cover both source and shared PostgreSQL server before transfer');
  if(source.source.major>target.destination.major || (source.source.clusterIdentity===target.destination.clusterIdentity && source.source.database===target.destination.database))
    throw new Error('Distinct non-downgrade PostgreSQL destination required');
  const networks=await inspectPostgresSourceNetworks(source.source.container,postgresDocker);
  const differs=deploymentDigest(source.source.locale)!==deploymentDigest(target.destination.locale);
  if(differs && !selection.allowLocaleConversion)throw new Error('Explicit logical-rebuild locale conversion is required');
  const localeConversion=differs ? postgresLocaleConversionSchema.parse({method:'logical-rebuild',source:source.source.locale,destination:target.destination.locale}) : undefined;
  const intent:PostgresTransferIntent={installationId:target.topology.installationId,environment:target.topology.environment,
    requirementId:selection.requirementId,topologyDigest:deploymentDigest(target.topology),runtimeDigest:target.component.runtimeDigest,
    source:{clusterIdentity:source.source.clusterIdentity,database:source.source.database,major:source.source.major},
    destination:{clusterIdentity:target.destination.clusterIdentity,database:target.destination.database,major:target.destination.major},
    sourceInventoryDigest:deploymentDigest({inventory:source.source.inventoryDigest,storage:source.storageDigest,configuration:source.configurationDigest}),
    destinationAllocationDigest:target.destination.allocationDigest,restorePointDigest:selection.backupDigest,
    ...(localeConversion?{localeConversion}:{})};
  // Include container/network/installed inventory and selected host configuration
  // in the plan, not merely same-named logical database descriptors.
  const plan={schemaVersion:'treeseed.managed-postgres-transfer-plan/v1' as const,
    intent,intentDigest:deploymentDigest(intent),sourceNetworks:networks,
    targetContainerDigest:target.containerDigest,configurationDigest:deploymentDigest(target.host),
    componentDigest:deploymentDigest(target.component),selectionDigest:deploymentDigest(selection)};
  return {...plan,planDigest:deploymentDigest(plan)};
}

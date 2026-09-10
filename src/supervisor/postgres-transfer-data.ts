import { mkdirSync } from 'node:fs';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { postgresTransferJournalRoot } from '../core/postgres-transfer-hold.js';
import { loadHostConfiguration } from '../core/configuration.js';
import { withLocalPostgresBootstrap } from '../postgres/connection.js';
import { withAttestedPostgresSource } from '../postgres/source-session.js';
import { inspectPostgresSourceNetworks,fencePostgresSourceNetworks,terminatePostgresTransferWriters } from '../postgres/transfer-fence.js';
import { fingerprintPostgresTransfer } from '../postgres/transfer-fingerprint.js';
import { verifyPostgresTransferFingerprints } from '../postgres/transfer-locale.js';
import { disablePostgresAllocation } from '../postgres/disable.js';
import { activatePostgresAllocation } from '../postgres/activation.js';
import { writePostgresLogicalArchive,restorePostgresLogicalArchive } from '../postgres/logical-archive.js';
import { startPostgresExport,startPostgresImport } from '../postgres/transfer-process.js';
import { managedPostgresTransferPlanSchema,managedPostgresTransferSelectionSchema,
  type ManagedPostgresTransferPlan,type ManagedPostgresTransferSelection } from '../postgres/managed-transfer-contract.js';
import type { PostgresTransferArchive } from '../postgres/transfer.js';
import { inspectManagedPostgresDestination } from './postgres-destination.js';
import type { PostgresTransferSourceReader } from './postgres-copy-reader.js';
import { activePostgresTransferJournal } from './postgres-transfer-guard.js';
import { postgresDocker } from './postgres-process.js';
import { withApplicationBackupKey } from './backup.js';
import { readComponentCredential } from './component-sealed.js';

/** Concrete root-owned data ports. The coordinator holds the journal OS lock
 * throughout. These are never caller-supplied callbacks or exposed independently
 * over the supervisor protocol. Every mutation requires the exact durable phase.
 */
export function managedPostgresTransferData(input:ManagedPostgresTransferSelection,planned:ManagedPostgresTransferPlan,readSource:PostgresTransferSourceReader) {
  const selection=managedPostgresTransferSelectionSchema.parse(input),plan=managedPostgresTransferPlanSchema.parse(planned);
  if(process.getuid?.()!==0 || plan.selectionDigest!==deploymentDigest(selection))throw new Error('Exact managed transfer custody required');
  const {intent}=plan;
  const phase=(...allowed:string[])=>{
    const active=activePostgresTransferJournal()?.active();
    if(!active || active.intentDigest!==plan.intentDigest || active.restoreGeneration!==selection.generation ||
      active.restoreDigest!==selection.backupDigest || !allowed.includes(active.stage))throw new Error('Exact durable transfer phase required');
    return active;
  };
  const source=async()=>{
    const value=await readSource();
    if(deploymentDigest({inventory:value.source.inventoryDigest,storage:value.storageDigest,configuration:value.configurationDigest})!==intent.sourceInventoryDigest ||
      value.source.container!==plan.sourceNetworks.container)throw new Error('Source transfer custody changed');
    return value;
  };
  const target=async(importing=false)=>{
    const value=await inspectManagedPostgresDestination(selection.selections,selection.requirementId,importing);
    if(value.containerDigest!==plan.targetContainerDigest || deploymentDigest(value.host)!==plan.configurationDigest ||
      deploymentDigest(value.component)!==plan.componentDigest || value.destination.allocationDigest!==intent.destinationAllocationDigest ||
      value.destination.clusterIdentity!==intent.destination.clusterIdentity)throw new Error('Destination transfer custody changed');
    return value;
  };
  const sourceSession=async<T>(run:Parameters<typeof withAttestedPostgresSource<T>>[2])=>{
    const value=await source(),major=value.source.major;
    if(major!==16 && major!==17)throw new Error('Unsupported source PostgreSQL major');
    return withAttestedPostgresSource({...value.source,username:value.username,major},postgresDocker,run);
  };
  const destinationSession=<T>(run:Parameters<typeof withLocalPostgresBootstrap<T>>[2])=>
    withLocalPostgresBootstrap('/run/treeseed/postgres/socket',intent.destination.database,run);
  const sourceFenced=async()=>{
    await source();
    if((await inspectPostgresSourceNetworks(plan.sourceNetworks.container,postgresDocker)).networks.length)return false;
    return sourceSession(async session=>(await session.query("SELECT NOT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend') AS idle")).rows[0]?.idle===true);
  };
  let fingerprint:Awaited<ReturnType<typeof fingerprintPostgresTransfer>>|undefined;
  const archiveRoot=`${postgresTransferJournalRoot}/archives`;
  return {
    revalidate:async()=>{await source();await target();return true;},
    sourceFenced,
    destinationEmpty:async()=>(await target()).destination.empty,
    fence:async()=>{
      phase('fencing','recovery-required');
      const results=await Promise.allSettled([(async()=>{
      const from=await source();
      const networks=await inspectPostgresSourceNetworks(from.source.container,postgresDocker);
      if(networks.networks.length)await fencePostgresSourceNetworks(from.source.container,plan.sourceNetworks.digest,postgresDocker);
      await sourceSession(session=>terminatePostgresTransferWriters(session,intent.source.database,[from.username]));
      })(),(async()=>{
      // Use the exact planned allocation, not a role supplied by a caller. The
      // disable adapter independently verifies ownership before terminating it.
      const host=loadHostConfiguration();
      if(deploymentDigest(host)!==plan.configurationDigest || !host.postgres || deploymentDigest(host.postgres)!==intent.topologyDigest)
        throw new Error('Destination containment custody changed');
      const topology=host.postgres;
      await destinationSession(async session=>{
        const identity=await session.query('SELECT current_database() AS database,(SELECT system_identifier::text FROM pg_control_system()) AS cluster');
        const row=identity.rows[0];
        if(identity.rows.length!==1 || row?.database!==intent.destination.database || typeof row.cluster!=='string' ||
          deploymentDigest({cluster:row.cluster})!==intent.destination.clusterIdentity)throw new Error('Destination containment identity changed');
        await disablePostgresAllocation(topology,selection.requirementId,session);
      });
      })()]);
      if(results.some(result=>result.status==='rejected'))throw new Error('PostgreSQL containment is incomplete; retain coordinated recovery');
    },
    writersFenced:async()=>{if(!await sourceFenced())return false;await target();return true;},
    export:async()=>{
      phase('export');if(!await sourceFenced())throw new Error('Source writer fence is unverified');
      const from=await source(),major=from.source.major;
      if(major!==16 && major!==17)throw new Error('Unsupported source major');
      fingerprint=await sourceSession(session=>fingerprintPostgresTransfer(session,{database:intent.source.database,owner:from.username,major}));
      mkdirSync(archiveRoot,{recursive:true,mode:0o700});
      const process=startPostgresExport({container:from.source.container,database:intent.source.database,username:from.username,intentDigest:plan.intentDigest});
      try{return await withApplicationBackupKey(key=>writePostgresLogicalArchive(archiveRoot,plan.intentDigest,key,process.output,process.completed));}
      finally{process.disconnect();}
    },
    restore:async(archive:PostgresTransferArchive)=>{
      if(phase('restore').archiveDigest!==archive.digest || archive.intentDigest!==plan.intentDigest || !archive.encrypted)
        throw new Error('Exact journaled PostgreSQL archive required');
      const destination=await target();
      if(!destination.destination.empty || !await sourceFenced())throw new Error('Transfer destination is occupied or source fence changed');
      const allocation=destination.topology.allocations.find(item=>item.requirementId===selection.requirementId)!;
      let process:ReturnType<typeof startPostgresImport>|undefined;
      try {
        await destinationSession(session=>activatePostgresAllocation(destination.topology,selection.requirementId,'migration',
          readComponentCredential(destination.host,allocation.migrationCredentialReference),session));
        await withApplicationBackupKey(key=>restorePostgresLogicalArchive(archiveRoot,plan.intentDigest,key,archive,async()=>{
          if(!(await target(true)).destination.empty)throw new Error('Transfer destination changed before import');
          process=startPostgresImport({container:destination.container,database:allocation.database,username:allocation.migrationRole,owner:allocation.ownerRole,intentDigest:plan.intentDigest});
          return {input:process.input,completed:process.completed};
        }));
      } finally {
        process?.disconnect();
        await destinationSession(session=>disablePostgresAllocation(destination.topology,selection.requirementId,session));
      }
    },
    verify:async()=>{
      phase('verify');if(!fingerprint || !await sourceFenced())return false;
      const destination=await target(),allocation=destination.topology.allocations.find(item=>item.requirementId===selection.requirementId)!;
      const actual=await destinationSession(session=>fingerprintPostgresTransfer(session,{database:allocation.database,owner:allocation.ownerRole,major:17}));
      const from=await source(),major=from.source.major;
      if(major!==16 && major!==17)return false;
      const sourceAfter=await sourceSession(session=>fingerprintPostgresTransfer(session,{database:intent.source.database,owner:from.username,major}));
      return deploymentDigest(sourceAfter)===deploymentDigest(fingerprint) && verifyPostgresTransferFingerprints(fingerprint,actual,intent.localeConversion);
    },
  };
}

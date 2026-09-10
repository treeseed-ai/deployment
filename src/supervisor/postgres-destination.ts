import { realpathSync } from 'node:fs';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { z } from 'zod';
import { loadHostConfiguration } from '../core/configuration.js';
import { withLocalPostgresBootstrap } from '../postgres/connection.js';
import { inspectPostgresTransferDestination } from '../postgres/transfer-destination.js';
import { componentStateRoot } from './component.js';
import { installedComponentRelease } from './component-release.js';
import { postgresDocker } from './postgres-process.js';
import { localPostgresTopology } from './postgres.js';

const stateSchema=z.object({id:z.string().regex(/^[a-f0-9]{64}$/u),image:z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  running:z.literal(true),started:z.string().min(1),
  mounts:z.array(z.object({Type:z.string(),Source:z.string(),Destination:z.string()}).passthrough()).max(128)}).strict();

/** Fixed installed target plus root-protected bootstrap socket. Prove that the
 * queried socket and data bind belong to that exact running PostgreSQL image;
 * a same-named database or Docker label alone never establishes ownership.
 */
export async function inspectManagedPostgresDestination(selections:Array<{componentId:string;release:string}>,
  requirementId:string, importing=false) {
  try {
    if(process.getuid?.()!==0)throw new Error();
    const host=loadHostConfiguration(), releases=selections.map(item=>installedComponentRelease(item.componentId,item.release));
    const topology=localPostgresTopology(host,releases);
    const requirement=topology.requirements.find(item=>item.id===requirementId && item.enabled);
    const allocation=topology.allocations.find(item=>item.requirementId===requirementId);
    const server=releases.find(item=>item.componentId==='postgres');
    const component=releases.find(item=>item.componentId===requirement?.componentId);
    const image=server?.images.find(item=>item.role==='postgres');
    if(!allocation || !component || !server || !image || server.runtimeDigest!==deploymentDigest(server.runtime) ||
      component.runtimeDigest!==deploymentDigest(component.runtime) ||
      !server.runtime.services.some(item=>item.composeService==='postgres'))throw new Error();
    const ids=(await postgresDocker(['ps','--all','--quiet','--no-trunc','--filter',
      `label=com.docker.compose.project=${server.runtime.compose.projectName}`,'--filter','label=com.docker.compose.service=postgres'],10,true)).trim().split(/\s+/u);
    if(ids.length!==1 || !/^[a-f0-9]{64}$/u.test(ids[0]!))throw new Error();
    const container=ids[0]!, imageId=(await postgresDocker(['image','inspect','--format','{{.Id}}',`${image.repository}@${image.digest}`],10,true)).trim();
    const inspect=async()=>{
      const state=stateSchema.parse(JSON.parse(await postgresDocker(['inspect','--format',
        '{"id":{{json .Id}},"image":{{json .Image}},"running":{{json .State.Running}},"started":{{json .State.StartedAt}},"mounts":{{json .Mounts}}}',container],10,true)));
      if(state.id!==container || state.image!==imageId)throw new Error();
      for(const [destination,source] of [['/var/lib/postgresql/data',`${componentStateRoot(host,'postgres')}/postgres`],
        ['/run/postgres/socket','/run/treeseed/postgres/socket']] as const) {
        const mounts=state.mounts.filter(item=>item.Destination===destination || item.Destination.startsWith(`${destination}/`));
        if(mounts.length!==1 || mounts[0]?.Type!=='bind' || mounts[0]?.Source!==source ||
          mounts[0]?.Destination!==destination || realpathSync(source)!==source)throw new Error();
      }
      return state;
    };
    const before=await inspect();
    const destination=await withLocalPostgresBootstrap('/run/treeseed/postgres/socket',allocation.database,
      session=>inspectPostgresTransferDestination(topology,requirementId,session,importing));
    const cluster=(await postgresDocker(['exec',container,'env','-i','PATH=/usr/local/bin:/usr/bin:/bin','PGPASSFILE=/dev/null',
      'psql','-XqAt','--no-password','-h','/run/postgres/socket','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1',
      '-c','SELECT system_identifier::text FROM pg_control_system()'],10,true)).trim();
    if(!/^[0-9]{1,20}$/u.test(cluster) || deploymentDigest({cluster})!==destination.clusterIdentity ||
      deploymentDigest(before)!==deploymentDigest(await inspect()) || deploymentDigest(host)!==deploymentDigest(loadHostConfiguration()) ||
      deploymentDigest(releases)!==deploymentDigest(selections.map(item=>installedComponentRelease(item.componentId,item.release))))throw new Error();
    return {host,topology,component,container,destination,containerDigest:deploymentDigest(before)};
  } catch {throw new Error('Managed PostgreSQL destination runtime custody is unavailable or changed; binding unchanged');}
}

import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { deploymentDigest,postgresTopologySchema } from '@treeseed/sdk/deployment';
import { component,host,hash } from './fixtures.js';
import { postgresComponentBundle } from '../src/postgres/release.js';
import { inspectManagedPostgresDestination } from '../src/supervisor/postgres-destination.js';

const f=vi.hoisted(()=>({host:vi.fn(),release:vi.fn(),topology:vi.fn(),docker:vi.fn(),session:vi.fn(),destination:vi.fn(),realpath:vi.fn()}));
vi.mock('../src/core/configuration.js',()=>({loadHostConfiguration:f.host}));
vi.mock('../src/supervisor/component-release.js',()=>({installedComponentRelease:f.release}));
vi.mock('../src/supervisor/postgres.js',()=>({localPostgresTopology:f.topology}));
vi.mock('../src/supervisor/postgres-process.js',()=>({postgresDocker:f.docker}));
vi.mock('../src/postgres/connection.js',()=>({withLocalPostgresBootstrap:f.session}));
vi.mock('../src/postgres/transfer-destination.js',()=>({inspectPostgresTransferDestination:f.destination}));
vi.mock('node:fs',async original=>({...await original<object>(),realpathSync:f.realpath}));
beforeEach(()=>{vi.clearAllMocks();vi.spyOn(process,'getuid').mockReturnValue(0);});
afterEach(()=>vi.restoreAllMocks());
function fixture() {
  const configuration=host(), application=component('api','stable','a'), server=postgresComponentBundle('0.1.0-rc.288','a'.repeat(40)).component;
  application.runtimeDigest=deploymentDigest(application.runtime);
  const topology=postgresTopologySchema.parse({schemaVersion:'treeseed.postgres-topology/v1',installationId:'test',environment:'production',
    servers:[{id:'shared',installationId:'test',environment:'production',mode:'shared',hostname:'postgres',port:5432,major:17,extensions:[],tls:{mode:'verify-full',trustReference:'postgres-ca'}}],
    requirements:[{id:'api',componentId:'api',enabled:true,supportedMajors:[17],extensions:[],runtimeConnectionLimit:10}],
    allocations:[{requirementId:'api',serverId:'shared',database:'api',ownerRole:'api_owner',migrationRole:'api_migrator',runtimeRole:'api_runtime',migrationCredentialReference:'api-migration',runtimeCredentialReference:'api-runtime',onDisable:'preserve'}]});
  const state={id:'b'.repeat(64),image:hash('c'),running:true,started:'2026-09-10T00:00:00Z',mounts:[
    {Type:'bind',Source:'/var/lib/treeseed/components/postgres/postgres',Destination:'/var/lib/postgresql/data'},
    {Type:'bind',Source:'/run/treeseed/postgres/socket',Destination:'/run/postgres/socket'}]};
  const destination={clusterIdentity:deploymentDigest({cluster:'123'}),database:'api',empty:true};
  f.host.mockReturnValue(configuration); f.topology.mockReturnValue(topology);
  f.release.mockImplementation(id=>id==='postgres'?server:application); f.realpath.mockImplementation(path=>path);
  f.session.mockImplementation(async(_path,_db,run)=>run({query:vi.fn()})); f.destination.mockResolvedValue(destination);
  f.docker.mockImplementation(async(args:string[])=>args[0]==='ps'?state.id:args[0]==='image'?hash('c'):args[0]==='inspect'?JSON.stringify(state):'123');
  return {state,configuration,destination,server,run:()=>inspectManagedPostgresDestination([
    {componentId:'api',release:application.release},{componentId:'postgres',release:server.release}],'api')};
}
it('binds the protected socket and data directory to the exact installed target container',async()=>{
  const v=fixture(),result=await v.run(); expect(result.container).toBe(v.state.id);
  expect(result.destination).toEqual(v.destination);
  expect(f.session.mock.calls[0]?.slice(0,2)).toEqual(['/run/treeseed/postgres/socket','api']);
});
it.each(['image','socket','data','nested','symlink','stopped','manifest'] as const)('rejects %s mismatch before database inspection',async kind=>{
  const v=fixture();
  if(kind==='image')v.state.image=hash('d');
  if(kind==='socket')v.state.mounts[1]!.Source='/other/socket';
  if(kind==='data')v.state.mounts[0]!.Source='/other/data';
  if(kind==='nested')v.state.mounts.push({Type:'bind',Source:'/other',Destination:'/var/lib/postgresql/data/base'});
  if(kind==='symlink')f.realpath.mockReturnValue('/elsewhere');
  if(kind==='stopped')v.state.running=false;
  if(kind==='manifest')v.server.runtimeDigest=hash('f');
  await expect(v.run()).rejects.toThrow('binding unchanged'); expect(f.session).not.toHaveBeenCalled();
});
it('rejects a bootstrap socket connected to a different PostgreSQL cluster',async()=>{
  const v=fixture(); v.destination.clusterIdentity=hash('f'); await expect(v.run()).rejects.toThrow('binding unchanged');
});
it('rejects a restarted target after inspection',async()=>{
  const v=fixture();f.destination.mockImplementation(async()=>{v.state.started='later';return v.destination;});
  await expect(v.run()).rejects.toThrow('binding unchanged');
});

import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { Readable,Writable } from 'node:stream';
import { deploymentDigest,postgresTopologySchema } from '@treeseed/sdk/deployment';
import { component,host,hash } from './fixtures.js';
import { planManagedPostgresTransfer } from '../src/supervisor/postgres-transfer-plan.js';
import { managedPostgresTransferData } from '../src/supervisor/postgres-transfer-data.js';
const f=vi.hoisted(()=>({source:vi.fn(),target:vi.fn(),reader:vi.fn(),networks:vi.fn(),fenceNetwork:vi.fn(),terminate:vi.fn(),
  sourceSession:vi.fn(),targetSession:vi.fn(),fingerprint:vi.fn(),journal:vi.fn(),host:vi.fn(),disable:vi.fn(),activate:vi.fn(),
  credential:vi.fn(),key:vi.fn(),export:vi.fn(),import:vi.fn(),write:vi.fn(),restore:vi.fn(),mkdir:vi.fn()}));
vi.mock('../src/supervisor/postgres-source-backup.js',()=>({inspectRecoveryPostgresSource:f.source,createRecoveryPostgresSourceReader:f.reader}));
vi.mock('../src/supervisor/postgres-destination.js',()=>({inspectManagedPostgresDestination:f.target}));
vi.mock('../src/postgres/transfer-fence.js',()=>({inspectPostgresSourceNetworks:f.networks,fencePostgresSourceNetworks:f.fenceNetwork,terminatePostgresTransferWriters:f.terminate}));
vi.mock('../src/postgres/source-session.js',()=>({withAttestedPostgresSource:f.sourceSession}));
vi.mock('../src/postgres/connection.js',()=>({withLocalPostgresBootstrap:f.targetSession}));
vi.mock('../src/postgres/transfer-fingerprint.js',()=>({fingerprintPostgresTransfer:f.fingerprint}));
vi.mock('../src/supervisor/postgres-transfer-guard.js',()=>({activePostgresTransferJournal:f.journal}));
vi.mock('../src/core/configuration.js',()=>({loadHostConfiguration:f.host}));
vi.mock('../src/postgres/disable.js',()=>({disablePostgresAllocation:f.disable}));
vi.mock('../src/postgres/activation.js',()=>({activatePostgresAllocation:f.activate}));
vi.mock('../src/supervisor/component-sealed.js',()=>({readComponentCredential:f.credential}));
vi.mock('../src/supervisor/backup.js',()=>({withApplicationBackupKey:f.key}));
vi.mock('../src/postgres/transfer-process.js',()=>({startPostgresExport:f.export,startPostgresImport:f.import}));
vi.mock('../src/postgres/logical-archive.js',()=>({writePostgresLogicalArchive:f.write,restorePostgresLogicalArchive:f.restore}));
vi.mock('node:fs',async original=>({...await original<object>(),mkdirSync:f.mkdir}));
beforeEach(()=>{vi.clearAllMocks();vi.spyOn(process,'getuid').mockReturnValue(0);});
afterEach(()=>vi.restoreAllMocks());
async function fixture() {
  const configuration=host(),application=component('api','stable','a');
  application.runtime.postgresLifecycle=[{requirementId:'api',credentialOwner:{uid:1000,gid:1000},migration:{composeService:'migration',completion:'exit-zero',timeoutSeconds:120},runtimeServices:['service']}];
  const topology=postgresTopologySchema.parse({schemaVersion:'treeseed.postgres-topology/v1',installationId:'test',environment:'production',
    servers:[{id:'shared',installationId:'test',environment:'production',mode:'shared',hostname:'postgres',port:5432,major:17,extensions:[],tls:{mode:'verify-full',trustReference:'ca'}}],
    requirements:[{id:'api',componentId:'api',enabled:true,supportedMajors:[17],extensions:[],runtimeConnectionLimit:10}],
    allocations:[{requirementId:'api',serverId:'shared',database:'api',ownerRole:'api_owner',migrationRole:'api_migrator',runtimeRole:'api_runtime',migrationCredentialReference:'api-migration',runtimeCredentialReference:'api-runtime',onDisable:'preserve'}]});
  configuration.postgres=topology;
  const locale={encoding:'UTF8',collate:'en_US.utf8',ctype:'en_US.utf8',provider:'c',version:'2.36',locale:null};
  const source={username:'source_owner',source:{container:'a'.repeat(64),clusterIdentity:hash('b'),database:'old_api',major:16,inventoryDigest:hash('c'),locale},
    storageDigest:hash('d'),configurationDigest:hash('e'),coveredState:['var/lib/treeseed/components/postgres/postgres']};
  const target={host:configuration,topology,component:application,container:'b'.repeat(64),containerDigest:hash('f'),
    destination:{clusterIdentity:deploymentDigest({cluster:'123'}),database:'api',major:17,allocationDigest:hash('b'),empty:true,locale}};
  const networks={container:source.source.container,networks:['c'.repeat(64)],digest:hash('d')};
  const selection={componentId:'api',serviceId:'database',requirementId:'api',generation:7,backupDigest:hash('e'),allowLocaleConversion:false,
    selections:[{componentId:'api',release:application.release}]};
  f.source.mockResolvedValue(source);f.reader.mockResolvedValue(()=>f.source());f.target.mockResolvedValue(target);f.networks.mockImplementation(async()=>({...networks}));
  f.host.mockReturnValue(configuration);f.fenceNetwork.mockImplementation(async()=>{networks.networks=[];});f.terminate.mockResolvedValue({fenced:true});
  f.sourceSession.mockImplementation(async(_selection,_docker,run)=>run({query:async()=>({rows:[{idle:true}]})}));
  const identity={database:'api',cluster:'123'};
  f.targetSession.mockImplementation(async(_path,_database,run)=>run({query:async()=>({rows:[identity]})}));
  const fingerprint={schemaDigest:hash('a'),definitionDigest:hash('b'),localeDigest:hash('c'),contentDigest:hash('d'),relationCount:1};
  f.fingerprint.mockResolvedValue(fingerprint);f.disable.mockResolvedValue({disabled:true});f.activate.mockResolvedValue({activated:true});
  f.credential.mockReturnValue('fixture-only-generated-password-never-logged');
  const keys:Buffer[]=[];f.key.mockImplementation(async run=>{const key=Buffer.alloc(32,9);keys.push(key);try{return await run(key);}finally{key.fill(0);}});
  const producer={output:Readable.from(['fixture']),completed:Promise.resolve(),disconnect:vi.fn()};
  const consumer={input:new Writable({write(_chunk,_encoding,done){done();}}),completed:Promise.resolve(),disconnect:vi.fn()};
  f.export.mockReturnValue(producer);f.import.mockReturnValue(consumer);
  const plan=await planManagedPostgresTransfer(selection),archive={digest:hash('f'),intentDigest:plan.intentDigest,encrypted:true as const};
  const journal={stage:'fencing',intentDigest:plan.intentDigest,restoreGeneration:7,restoreDigest:selection.backupDigest,archiveDigest:archive.digest};
  f.journal.mockReturnValue({active:()=>journal});
  f.write.mockResolvedValue(archive);f.restore.mockImplementation(async(_root,_digest,_key,_archive,open)=>{await open();target.destination.empty=false;});
  const data=managedPostgresTransferData(selection,plan);
  return {source,target,networks,selection,plan,archive,journal,data,producer,consumer,keys,identity,fingerprint};
}
it('enforces durable phases before running privileged mutations or opening key custody',async()=>{
  const v=await fixture();v.journal.stage='wrong';
  for(const run of [()=>v.data.fence(),()=>v.data.export(),()=>v.data.restore(v.archive)])await expect(run()).rejects.toThrow('phase');
  expect(f.export).not.toHaveBeenCalled();expect(f.import).not.toHaveBeenCalled();expect(f.key).not.toHaveBeenCalled();expect(f.disable).not.toHaveBeenCalled();
});
it('attempts target containment even if source custody has become unavailable',async()=>{
  const v=await fixture();f.source.mockRejectedValue(new Error('source unavailable'));
  await expect(v.data.fence()).rejects.toThrow('containment');expect(f.disable).toHaveBeenCalledTimes(1);
});
it('does not disable an unrelated destination cluster during failure containment',async()=>{
  const v=await fixture();v.identity.cluster='999';await expect(v.data.fence()).rejects.toThrow('containment');
  expect(f.disable).not.toHaveBeenCalled();expect(f.fenceNetwork).toHaveBeenCalled();
});
it('exports through existing backup custody only after source isolation',async()=>{
  const v=await fixture();v.journal.stage='export';await expect(v.data.export()).rejects.toThrow('fence');expect(f.export).not.toHaveBeenCalled();
  v.journal.stage='fencing';await v.data.fence();v.journal.stage='export';expect(await v.data.export()).toEqual(v.archive);
  expect(f.export.mock.calls[0]?.[0]).toMatchObject({container:v.source.source.container,username:'source_owner',database:'old_api'});
  expect(v.producer.disconnect).toHaveBeenCalled();expect(v.keys.every(key=>key.every(value=>value===0))).toBe(true);
  expect(f.reader).toHaveBeenCalledTimes(1);
});
it('restores under the restricted migrator, closes it and verifies copied data with both sides fenced',async()=>{
  const v=await fixture();await v.data.fence();v.journal.stage='export';await v.data.export();v.journal.stage='restore';await v.data.restore(v.archive);
  expect(f.import.mock.calls[0]?.[0]).toMatchObject({username:'api_migrator',owner:'api_owner',database:'api'});
  expect(f.credential.mock.calls[0]?.[1]).toBe('api-migration');expect(v.consumer.disconnect).toHaveBeenCalled();
  expect(f.disable).toHaveBeenCalledTimes(2);expect(await v.data.writersFenced()).toBe(true);
  v.journal.stage='verify';expect(await v.data.verify()).toBe(true);
  expect(v.keys.every(key=>key.every(value=>value===0))).toBe(true);
});
it.each(['archive','occupied'] as const)('rejects %s before enabling migration access',async kind=>{
  const v=await fixture();await v.data.fence();v.journal.stage='restore';
  if(kind==='archive')v.journal.archiveDigest=hash('a');else v.target.destination.empty=false;
  await expect(v.data.restore(v.archive)).rejects.toThrow();expect(f.activate).not.toHaveBeenCalled();expect(f.import).not.toHaveBeenCalled();
});
it('disables migration access even when the import process fails',async()=>{
  const v=await fixture();await v.data.fence();v.journal.stage='restore';
  f.restore.mockImplementation(async(_root,_digest,_key,_archive,open)=>{await open();throw new Error('fixture failure');});
  await expect(v.data.restore(v.archive)).rejects.toThrow();expect(f.disable).toHaveBeenCalledTimes(2);expect(v.consumer.disconnect).toHaveBeenCalled();
});
it('rejects changed source data after copying and does not reconstruct an interrupted fingerprint',async()=>{
  const v=await fixture();await v.data.fence();v.journal.stage='verify';expect(await v.data.verify()).toBe(false);
  v.journal.stage='export';await v.data.export();v.journal.stage='verify';
  f.fingerprint.mockImplementation(async(_session,expected)=>expected.owner==='source_owner'?{...v.fingerprint,contentDigest:hash('e')}:v.fingerprint);
  expect(await v.data.verify()).toBe(false);
});

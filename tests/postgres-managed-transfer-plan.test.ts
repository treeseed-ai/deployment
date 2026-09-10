import { beforeEach,expect,it,vi } from 'vitest';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { component,host,hash } from './fixtures.js';
import { planManagedPostgresTransfer } from '../src/supervisor/postgres-transfer-plan.js';
import { supervisorOperationSchema } from '../src/supervisor/protocol.js';
const f=vi.hoisted(()=>({source:vi.fn(),target:vi.fn(),networks:vi.fn()}));
vi.mock('../src/supervisor/postgres-source-backup.js',()=>({inspectRecoveryPostgresSource:f.source}));
vi.mock('../src/supervisor/postgres-destination.js',()=>({inspectManagedPostgresDestination:f.target}));
vi.mock('../src/postgres/transfer-fence.js',()=>({inspectPostgresSourceNetworks:f.networks}));
beforeEach(()=>vi.clearAllMocks());
function fixture() {
  const configuration=host(), application=component('api','stable','a');
  application.runtime.postgresLifecycle=[{requirementId:'api',credentialOwner:{uid:1000,gid:1000},migration:{composeService:'migration',completion:'exit-zero',timeoutSeconds:120},runtimeServices:['service']}];
  const locale={encoding:'UTF8',collate:'en_US.utf8',ctype:'en_US.utf8',provider:'c',version:'2.36' as string|null,locale:null};
  const source={source:{container:'a'.repeat(64),clusterIdentity:hash('b'),database:'old_api',major:16,inventoryDigest:hash('c'),locale:{...locale}},
    storageDigest:hash('d'),configurationDigest:hash('e'),coveredState:['var/lib/treeseed/components/postgres/postgres']};
  const target={host:configuration,component:application,topology:{installationId:'test',environment:'production'},containerDigest:hash('f'),
    destination:{clusterIdentity:hash('a'),database:'api',major:17,allocationDigest:hash('b'),empty:true,locale:{...locale}}};
  const networks={container:source.source.container,networks:['c'.repeat(64)],digest:hash('d')};
  const selection={componentId:'api',serviceId:'database',requirementId:'api',generation:7,backupDigest:hash('e'),allowLocaleConversion:false,
    selections:[{componentId:'api',release:application.release}]};
  f.source.mockResolvedValue(source);f.target.mockResolvedValue(target);f.networks.mockResolvedValue(networks);
  return {source,target,networks,selection,run:()=>planManagedPostgresTransfer(selection)};
}
it('freezes exact source, destination, covered recovery, configuration and runtime without mutations',async()=>{
  const v=fixture(),plan=await v.run(),{planDigest,...descriptor}=plan;
  expect(planDigest).toBe(deploymentDigest(descriptor));expect(plan.intent.source.database).toBe('old_api');expect(plan.intent.destination.database).toBe('api');
  expect(plan.intent.restorePointDigest).toBe(v.selection.backupDigest);
  expect(JSON.stringify(plan)).not.toContain('/var/lib/');expect(JSON.stringify(plan)).not.toContain('password');
  expect(await v.run()).toEqual(plan);
});
it.each(['source-only-backup','nonempty','wrong-component','downgrade','same-database','wrong-lifecycle'] as const)('rejects %s before any execution',async kind=>{
  const v=fixture();
  if(kind==='source-only-backup')v.source.coveredState=[];
  if(kind==='nonempty')v.target.destination.empty=false;
  if(kind==='wrong-component')v.target.component.componentId='other';
  if(kind==='downgrade')v.target.destination.major=15;
  if(kind==='same-database'){v.target.destination.clusterIdentity=v.source.source.clusterIdentity;v.target.destination.database=v.source.source.database;}
  if(kind==='wrong-lifecycle')v.target.component.runtime.postgresLifecycle=[];
  await expect(v.run()).rejects.toThrow();
});
it('requires and freezes explicit Alpine-to-Bookworm logical locale conversion',async()=>{
  const v=fixture();v.source.source.locale.version=null;await expect(v.run()).rejects.toThrow('Explicit');
  v.selection.allowLocaleConversion=true;const plan=await v.run();expect(plan.intent.localeConversion?.source.version).toBeNull();
  expect(plan.intent.localeConversion?.destination.version).toBe('2.36');
  v.target.destination.locale.encoding='LATIN1';await expect(v.run()).rejects.toThrow();
});
it('changes the exact plan for network or target process drift',async()=>{
  const v=fixture(),initial=await v.run();v.networks.digest=hash('f');expect((await v.run()).planDigest).not.toBe(initial.planDigest);
  const next=await v.run();v.target.containerDigest=hash('e');expect((await v.run()).planDigest).not.toBe(next.planDigest);
});
it('accepts no caller SQL, paths, login values or addresses on the wire',()=>{
  const v=fixture(),request={operation:'postgres.transfer.plan',...v.selection};expect(supervisorOperationSchema.safeParse(request).success).toBe(true);
  for(const extra of [{sql:'SELECT 1'},{path:'/tmp/backup'},{username:'postgres'},{hostname:'other'},{generation:0},{allowLocaleConversion:'yes'}])
    expect(supervisorOperationSchema.safeParse({...request,...extra}).success).toBe(false);
});

import { beforeEach, expect, it, vi } from 'vitest';
import { deploymentDigest, postgresTopologySchema } from '@treeseed/sdk/deployment';
import { component, host, hash } from './fixtures.js';
import { requirePostgresTransition } from '../src/supervisor/postgres-transition.js';
import type { PostgresTransferIntent } from '../src/postgres/transfer.js';

const f=vi.hoisted(()=>({exists:vi.fn(),read:vi.fn(),journal:vi.fn()}));
vi.mock('node:fs',async original=>({...await original<object>(),existsSync:f.exists,readFileSync:f.read}));
vi.mock('../src/supervisor/postgres-transfer-guard.js',()=>({activePostgresTransferJournal:f.journal}));
beforeEach(()=>vi.clearAllMocks());
function fixture() {
  const configuration=host(), previous=component('api','stable','a'), next=component('api','stable','b');
  previous.images[0]!.repository='postgres';
  previous.runtimeDigest=deploymentDigest(previous.runtime);
  next.runtime.services.push({id:'migration',composeService:'migration',endpoints:[]});
  next.runtime.stateVolumes=[{id:'postgres',volume:'/var/lib/treeseed/components/api/postgres',backup:'required'}];
  next.runtime.postgresRequirements=[{id:'api',supportedMajors:[17],extensions:[],runtimeConnectionLimit:10}];
  next.runtime.postgresLifecycle=[{requirementId:'api',credentialOwner:{uid:1000,gid:1000},
    migration:{composeService:'migration',completion:'exit-zero',timeoutSeconds:120},runtimeServices:['service']}];
  next.runtimeDigest=deploymentDigest(next.runtime);
  configuration.postgres=postgresTopologySchema.parse({schemaVersion:'treeseed.postgres-topology/v1',installationId:'test',environment:'production',
    servers:[{id:'shared',installationId:'test',environment:'production',mode:'shared',hostname:'postgres',port:5432,major:17,extensions:[],tls:{mode:'verify-full',trustReference:'postgres-ca'}}],
    requirements:[{id:'api',componentId:'api',enabled:true,supportedMajors:[17],extensions:[],runtimeConnectionLimit:10}],
    allocations:[{requirementId:'api',serverId:'shared',database:'api',ownerRole:'api_owner',migrationRole:'api_migrator',runtimeRole:'api_runtime',migrationCredentialReference:'api-migration',runtimeCredentialReference:'api-runtime',onDisable:'preserve'}]});
  const intent:PostgresTransferIntent={installationId:'test',environment:'production',requirementId:'api',topologyDigest:deploymentDigest(configuration.postgres),runtimeDigest:next.runtimeDigest,
    source:{clusterIdentity:hash('a'),database:'api',major:16},destination:{clusterIdentity:hash('b'),database:'api',major:17},
    sourceInventoryDigest:hash('c'),destinationAllocationDigest:hash('d'),restorePointDigest:hash('e')};
  const journal={stage:'activate',intentDigest:deploymentDigest(intent),restoreDigest:intent.restorePointDigest};
  f.exists.mockImplementation(path=>String(path).endsWith('active-components.json'));
  f.read.mockImplementation(()=>JSON.stringify([previous])); f.journal.mockReturnValue({active:()=>journal});
  return {configuration,previous,next,intent,journal,run:()=>requirePostgresTransition(configuration,next)};
}
it('blocks normal activation before an old database can be replaced by a fresh allocation',()=>{
  const fxt=fixture(); expect(fxt.run).toThrow('verified managed transfer');
});
it('allows a genuinely fresh installation and an already migrated consumer',()=>{
  const fxt=fixture(); f.exists.mockReturnValue(false); expect(fxt.run).not.toThrow();
  f.exists.mockReturnValue(true); f.read.mockImplementation(()=>JSON.stringify([fxt.next])); expect(fxt.run).not.toThrow();
});
it('does not mistake missing active metadata with retained database files for a fresh installation',()=>{
  const fxt=fixture(); f.exists.mockImplementation(path=>String(path).endsWith('PG_VERSION')); expect(fxt.run).toThrow('verified managed transfer');
});
it('uses the declared nested AI data volume instead of assuming the API directory layout',()=>{
  const fxt=fixture();fxt.next.runtime.stateVolumes[0]!.volume='/var/lib/treeseed/components/api/data/postgres';
  f.exists.mockImplementation(path=>String(path).endsWith('/data/postgres/PG_VERSION'));
  expect(fxt.run).toThrow('verified managed transfer');
});
it('fails closed on corrupt or duplicate active component records',()=>{
  const fxt=fixture(); f.read.mockReturnValue('invalid'); expect(fxt.run).toThrow();
  f.read.mockReturnValue(JSON.stringify([fxt.previous,fxt.previous])); expect(fxt.run).toThrow('Ambiguous');
});
it('allows only the exact internal verified activation phase',()=>{
  const fxt=fixture(); expect(()=>requirePostgresTransition(fxt.configuration,fxt.next,fxt.intent)).not.toThrow();
  fxt.journal.stage='restore'; expect(()=>requirePostgresTransition(fxt.configuration,fxt.next,fxt.intent)).toThrow('verified managed transfer');
});
it.each(['topologyDigest','runtimeDigest','restorePointDigest','requirementId','installationId'] as const)('denies changed %s even with a matching transaction hash',field=>{
  const fxt=fixture(); fxt.intent[field]=hash('f'); fxt.journal.intentDigest=deploymentDigest(fxt.intent);
  expect(()=>requirePostgresTransition(fxt.configuration,fxt.next,fxt.intent)).toThrow('verified managed transfer');
});

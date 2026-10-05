import { afterEach,expect,it } from 'vitest';
import { chmodSync,linkSync,mkdtempSync,readFileSync,rmSync,statSync,symlinkSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { PostgresTransferPlanStore } from '../src/postgres/transfer-plan-store.js';
import { managedPostgresTransferPlanSchema } from '../src/postgres/managed-transfer-contract.js';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const hash=(value:string)=>`sha256:${value.repeat(64)}`;
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'treeseed-transfer-plan-'));roots.push(root);
  const selection={componentId:'api',serviceId:'database',requirementId:'api',generation:7,backupDigest:hash('e'),allowLocaleConversion:false,
    selections:[{componentId:'api',release:'1.0.0'}]};
  const intent={installationId:'test',environment:'staging',requirementId:'api',topologyDigest:hash('a'),runtimeDigest:hash('b'),
    source:{clusterIdentity:hash('c'),database:'source',major:16},destination:{clusterIdentity:hash('d'),database:'target',major:17},
    sourceInventoryDigest:hash('e'),destinationAllocationDigest:hash('f'),restorePointDigest:selection.backupDigest};
  const descriptor={schemaVersion:'treeseed.managed-postgres-transfer-plan/v1',intent,intentDigest:deploymentDigest(intent),
    sourceNetworks:{container:'a'.repeat(64),networks:['b'.repeat(64)],digest:hash('c')},targetContainerDigest:hash('d'),
    configurationDigest:hash('e'),componentDigest:hash('f'),selectionDigest:deploymentDigest(selection)};
  const plan=managedPostgresTransferPlanSchema.parse({...descriptor,planDigest:deploymentDigest(descriptor)});
  const record={selection,plan},store=new PostgresTransferPlanStore(root),path=join(root,`${plan.planDigest.slice(7)}.json`);
  return {root,store,record,path};
}
it('durably retains exact immutable descriptors for replay after process restart',()=>{
  const v=fixture();expect(v.store.read(v.record.plan.planDigest)).toBeNull();
  expect(v.store.save(v.record).action).toBe('recorded');expect(statSync(v.path).mode&0o777).toBe(0o600);
  const bytes=readFileSync(v.path,'utf8'),restarted=new PostgresTransferPlanStore(v.root);
  expect(restarted.read(v.record.plan.planDigest)).toEqual(v.record);
  expect(restarted.save(v.record).action).toBe('noop');expect(readFileSync(v.path,'utf8')).toBe(bytes);
});
it.each(['intent','selection','plan','unknown'] as const)('rejects changed %s without replacing the existing plan',kind=>{
  const v=fixture();v.store.save(v.record);const original=readFileSync(v.path,'utf8');
  if(kind==='intent')v.record.plan.intent.destination.database='other';
  if(kind==='selection')v.record.selection.generation=8;
  if(kind==='plan')v.record.plan.targetContainerDigest=hash('a');
  expect(()=>v.store.save(kind==='unknown'?{...v.record,password:'never accepted'}:v.record)).toThrow();
  expect(readFileSync(v.path,'utf8')).toBe(original);
});
it.each(['corrupt','mode','hardlink','symlink'] as const)('fails closed on %s custody without deleting it',kind=>{
  const v=fixture();
  if(kind==='symlink')symlinkSync(join(v.root,'missing'),v.path);
  else {
    v.store.save(v.record);
    if(kind==='corrupt')writeFileSync(v.path,'{}');
    if(kind==='mode')chmodSync(v.path,0o644);
    if(kind==='hardlink')linkSync(v.path,join(v.root,'second-link'));
  }
  expect(()=>v.store.read(v.record.plan.planDigest)).toThrow();expect(()=>v.store.save(v.record)).toThrow();
});
it('rejects path traversal, duplicate selections and caller-chosen plan digests',()=>{
  const v=fixture();expect(()=>v.store.read('../escape')).toThrow();
  expect(()=>v.store.save({...v.record,selection:{...v.record.selection,selections:[...v.record.selection.selections,...v.record.selection.selections]}})).toThrow();
  v.record.plan.planDigest=hash('a');expect(()=>v.store.save(v.record)).toThrow();
});

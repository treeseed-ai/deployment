import { beforeEach,expect,it,vi } from 'vitest';
import { executePostgresOperation,isPostgresOperation } from '../src/supervisor/postgres-operations.js';
import { component, host } from './fixtures.js';
const f=vi.hoisted(()=>({locked:false,held:false,reconcile:vi.fn(),activate:vi.fn(),lock:vi.fn()}));
vi.mock('../src/supervisor/postgres.js',()=>({reconcileLocalPostgres:f.reconcile}));
vi.mock('../src/supervisor/postgres-lifecycle.js',()=>({activateLocalPostgresComponent:f.activate}));
vi.mock('../src/supervisor/postgres-transfer-guard.js',()=>({postgresTransferJournal:()=>({locked:f.lock,active:()=>f.held?{}:null})}));
vi.mock('../src/core/configuration.js',()=>({loadHostConfiguration:()=>host()}));
vi.mock('../src/supervisor/component-release.js',()=>({installedComponentRelease:()=>component('api','stable','a')}));
vi.mock('../src/supervisor/postgres-transition-custody.js',()=>({previousPostgresComponent:()=>undefined}));
beforeEach(()=>{
  vi.clearAllMocks();f.locked=false;f.held=false;
  f.lock.mockImplementation(async(run)=>{f.locked=true;try{return await run();}finally{f.locked=false;}});
  f.activate.mockImplementation(async()=>{expect(f.locked).toBe(true);return {action:'activated'};});
  f.reconcile.mockImplementation(async()=>{expect(f.locked).toBe(true);return {applied:true};});
});
const selections=[{componentId:'api',release:'1.0.0'}];
it('holds the transfer OS lock throughout allocation mutation and component activation',async()=>{
  await executePostgresOperation({operation:'postgres.apply',selections,topologyDigest:'a'.repeat(64),inventoryDigest:'b'.repeat(64)});
  await executePostgresOperation({operation:'postgres.component.activate',componentId:'api',selections});
  expect(f.lock).toHaveBeenCalledTimes(2);expect(f.locked).toBe(false);
});
it('checks the durable hold after obtaining the lock, closing the asynchronous entry race',async()=>{
  f.lock.mockImplementation(async run=>{f.held=true;return run();});
  await expect(executePostgresOperation({operation:'postgres.component.activate',componentId:'api',selections})).rejects.toThrow('coordinated recovery');
  expect(f.activate).not.toHaveBeenCalled();expect(f.reconcile).not.toHaveBeenCalled();
});
it('keeps read-only allocation diagnostics available and routes only exact known operations',async()=>{
  f.reconcile.mockResolvedValue({ready:false});await executePostgresOperation({operation:'postgres.plan',selections});
  expect(f.lock).not.toHaveBeenCalled();expect(isPostgresOperation({operation:'postgres.transfer.status'})).toBe(false);
  expect(isPostgresOperation({operation:'postgres.plan',selections})).toBe(true);
});

import {expect,it,vi} from 'vitest';
import {KataSandboxRuntime} from '../src/sandbox/runtime.js';
const io=vi.hoisted(()=>({remove:vi.fn(async()=>undefined)}));
vi.mock('node:fs/promises',()=>({appendFile:vi.fn(),chmod:vi.fn(),chown:vi.fn(),mkdir:vi.fn(),readFile:vi.fn(async()=>'nameserver 192.0.2.53\n'),rename:vi.fn(),rm:io.remove,stat:vi.fn(),writeFile:vi.fn()}));

it('retains the exact acquired warm VM identity in the original assigned event before any subsequent guest failure',async()=>{
 for(const warmed of [false,true]) for(const allowedServices of [[],['treedx-relay']]){
  const vmId='sandbox-warm-11111111-1111-4111-8111-111111111111',sandboxId='sandbox-original-attempt',events:Array<{type:string;payload:Record<string,unknown>}>=[];
  const sandbox={assignment:{leaseExpiresAt:new Date(Date.now()+60_000).toISOString(),network:{allowedServices},profile:'isolated',modelPolicy:{model:'original-unit-model'},inputs:[],guestImage:'pinned/guest',guestImageDigest:'sha256:'+'a'.repeat(64),resources:{cpuCores:1,memoryBytes:1073741824}},uploaded:new Set(),directory:'/controlled/owner',inputDirectory:'/controlled/owner/input'};
  const marker=new Error('Original subsequent guest boundary failure'),acquire=vi.fn(async()=>({id:vmId,warmed}));
  const runtime={authorized:vi.fn(()=>sandbox),configuration:{},warmPool:{acquire},sandboxes:new Map([[sandboxId,sandbox]]),emit:vi.fn(async(_sandbox:unknown,type:string,payload:Record<string,unknown>)=>{events.push({type,payload});if(payload.stage==='vm.assigned')throw marker;})};
  await expect(KataSandboxRuntime.prototype.execute.call(runtime as unknown as KataSandboxRuntime,sandboxId,'original-token',{})).rejects.toBe(marker);
  expect(events.filter(event=>event.payload.stage==='vm.assigned')).toEqual([{type:'execution.progress',payload:{stage:'vm.assigned',warmed,vmId}}]);
  expect(Reflect.get(sandbox,'warmSandboxId')).toBe(vmId);expect(acquire).toHaveBeenCalledOnce();
  expect(acquire).toHaveBeenCalledExactlyOnceWith({image:'pinned/guest@sha256:'+'a'.repeat(64),cpuCores:1,memoryBytes:1073741824,network:allowedServices.length?'relay':'none'});
  await expect(KataSandboxRuntime.prototype.execute.call(runtime as unknown as KataSandboxRuntime,sandboxId,'original-token',{})).rejects.toThrow('already been claimed');expect(acquire).toHaveBeenCalledOnce();
 }
});
it('retains exact execution VM custody on verified and uncertain destruction without deleting uncertain resources or inventing an unassigned VM',async()=>{
 for(const mode of ['verified','uncertain','unassigned']){
  io.remove.mockClear();const sandboxId='sandbox-original-attempt',vmId='sandbox-warm-11111111-1111-4111-8111-111111111111';
  const sandbox={...(mode==='unassigned'?{}:{warmSandboxId:vmId}),directory:'/controlled/owner',toolWaiters:new Map(),events:[]};
  const emit=vi.fn(async()=>undefined),removeContainer=vi.fn((id:string)=>!(mode==='uncertain'&&id===vmId));
  const runtime={authorized:vi.fn(()=>sandbox),removeContainer,emit,sandboxes:new Map([[sandboxId,sandbox]])};
  const result=await KataSandboxRuntime.prototype.destroy.call(runtime as unknown as KataSandboxRuntime,sandboxId,'original-token');
  expect(emit).toHaveBeenCalledExactlyOnceWith(sandbox,'sandbox.destroyed',{verified:mode!=='uncertain',sourceTeardown:null,vmId:mode==='unassigned'?null:vmId});
  expect(result.destroyed).toBe(mode!=='uncertain');expect(removeContainer.mock.calls.map(call=>call[0])).toEqual(mode==='unassigned'?[sandboxId]:[sandboxId,vmId]);
  expect(io.remove.mock.calls.length).toBe(mode==='uncertain'?0:1);expect(runtime.sandboxes.has(sandboxId)).toBe(mode==='uncertain');
 }
});

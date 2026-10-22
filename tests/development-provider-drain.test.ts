import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { stopForHandoff } from '../src/supervisor/development-agent-container.js';
import * as doctor from '../src/sandbox/doctor.js';
import * as configuration from '../src/sandbox/configuration.js';
const temporary:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const root of temporary.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(value:string,failedStop='',manager=true,owned=true) {
  const root=mkdtempSync(resolve(tmpdir(),'provider-drain-'));temporary.push(root);
  mkdirSync(resolve(root,'runtime'));writeFileSync(resolve(root,'runtime/capacity-state.json'),value);
  const states:Record<string,boolean>={manager,runner:true},effects:string[]=[];
  const command=(_executable:string,args:readonly string[])=>{
    const service=(args[0]==='inspect'?args[1]:args.at(-1))!.includes('manager')?'manager':'runner';
    if(args[0]==='inspect')return JSON.stringify({labels:{'com.docker.compose.project':owned?'treeseed-agent':'foreign','com.docker.compose.service':service},running:states[service],environment:[]});
    effects.push(`${args[0]}:${service}`);
    if(args[0]==='stop') {states[service]=false;if(failedStop===service)throw new Error('uncertain stop');}
    if(args[0]==='start')states[service]=true;
    return '';
  };
  return {root,states,effects,run:(restore=()=>command('/usr/bin/docker',['start','treeseed-agent-manager-1']))=>stopForHandoff(command,root,restore)};
}
const inventory=(status:string)=>JSON.stringify({schemaVersion:1,claims:[{id:'arbitrary-configured-agent',status}]});
it('rejects active claims before draining execution and restores admissions',()=>{
  for(const status of ['ready','running','recovery']) {
    const f=fixture(inventory(status));expect(()=>f.run()).toThrow('cannot interrupt');
    expect(f.states).toEqual({manager:true,runner:true});expect(f.effects).toEqual(['stop:manager','start:manager']);
  }
});
it('restores admissions on unreadable claim syntax or invalid inventory',()=>{
  for(const value of ['not-json',inventory('unknown')]) {
    const f=fixture(value);expect(()=>f.run()).toThrow();expect(f.states).toEqual({manager:true,runner:true});
    expect(f.effects).toEqual(['stop:manager','start:manager']);
  }
});
it('drains empty and polling inventory without invoking restoration',()=>{
  for(const value of [inventory('polling'),inventory('unresolved'),JSON.stringify({schemaVersion:1,claims:[]})]) {
    const f=fixture(value);f.run(()=>{throw new Error('unexpected restore');});
    expect(f.states).toEqual({manager:false,runner:false});expect(f.effects).toEqual(['stop:manager','stop:runner']);
  }
});
it('restores uncertain runner stop before reopening admissions',()=>{
  const f=fixture(inventory('polling'),'runner');expect(()=>f.run()).toThrow('uncertain stop');
  expect(f.states).toEqual({manager:true,runner:true});expect(f.effects).toEqual(['stop:manager','stop:runner','start:runner','start:manager']);
});
it('restores uncertain manager stop without draining execution',()=>{
  const f=fixture(inventory('polling'),'manager');expect(()=>f.run()).toThrow('uncertain stop');
  expect(f.states).toEqual({manager:true,runner:true});expect(f.effects).toEqual(['stop:manager','start:manager']);
});
it('does not restart an originally stopped manager on rejected handoff',()=>{
  const f=fixture(inventory('ready'),'',false);expect(()=>f.run()).toThrow('cannot interrupt');
  expect(f.states).toEqual({manager:false,runner:true});expect(f.effects).toEqual([]);
});
it('propagates restoration failure instead of claiming recovered execution',()=>{
  const f=fixture(inventory('ready'));expect(()=>f.run(()=>{throw new Error('restoration failed');})).toThrow('restoration failed');
  expect(f.states).toEqual({manager:false,runner:true});expect(f.effects).toEqual(['stop:manager']);
});
it('rejects unowned containers before any stop or restoration side effect',()=>{
  const f=fixture(inventory('polling'),'',true,false);expect(()=>f.run()).toThrow('ownership');
  expect(f.states).toEqual({manager:true,runner:true});expect(f.effects).toEqual([]);
});

it('drains a physically closed recovery for code handoff while retaining its original accounting and product bytes',()=>{
 const at=new Date().toISOString(),claim={id:'closed',status:'recovery',activeStartedAt:at,activeFinishedAt:at,
  requestedSeconds:162,failureMessage:'retained failure',dispatchEnvelope:{original:'held'},
  closeoutOutput:{sandboxId:'original-sandbox',teardown:{verified:true,completedAt:at},product:'original'}};
 const value=JSON.stringify({schemaVersion:1,claims:[claim]});const f=fixture(value);f.run();
 expect(f.states).toEqual({manager:false,runner:false});expect(f.effects).toEqual(['stop:manager','stop:runner']);
 expect(readFileSync(resolve(f.root,'runtime/capacity-state.json'),'utf8')).toBe(value);
});

it('replaces provider code after expired unknown recovery is physically fenced without inventing closure or settling usage',()=>{
 const deadline=new Date(Date.now()-60_000).toISOString(),started=new Date(Date.now()-120_000).toISOString();
 const claim={id:'retained',assignmentId:'original-assignment',status:'recovery',leaseExpiresAt:deadline,
  activeStartedAt:started,accountedThrough:started,requestedSeconds:390,failureMessage:'original failure',
  dispatchEnvelope:{assignment:{assignmentAttempt:{schemaVersion:'treeseed.assignment-attempt/v1',id:'original-assignment',deadline}}}};
 const value=JSON.stringify({schemaVersion:1,claims:[claim],usage:{original:1234}}),f=fixture(value),effects:string[]=[];
 vi.spyOn(configuration,'loadSandboxBrokerConfiguration').mockReturnValue({containerdAddress:'/run/containerd/containerd.sock',namespace:'treeseed-sandboxes'} as ReturnType<typeof configuration.loadSandboxBrokerConfiguration>);
 vi.spyOn(doctor,'inspectVmProcesses').mockReturnValue({processes:[],pidNamespace:'pid:[1]',complete:true});
 const transport=(executable:string,args:readonly string[])=>{
  effects.push(executable.endsWith('docker')?`${args[0]}:${args.at(-1)}`:`${executable}:${args.join(' ')}`);
	if(executable.endsWith('docker')){
	 const service=(args[0]==='inspect'?args[1]:args.at(-1))!.includes('manager')?'manager':'runner';
	 if(args[0]==='inspect')return JSON.stringify({labels:{'com.docker.compose.project':'treeseed-agent','com.docker.compose.service':service},running:f.states[service],environment:[]});
	 f.states[service]=args[0]==='start';
	}
	if(executable.endsWith('systemctl')&&args[0]==='show')return 'inactive\n';
  return '';
 };
 stopForHandoff(transport,f.root,()=>{throw new Error('unexpected restore');});
 expect(effects.some(effect=>effect.includes('stop treeseed-sandbox-broker.service'))).toBe(true);
 expect(effects.filter(effect=>effect.startsWith('/usr/bin/systemctl:')).at(-1)).toBe('/usr/bin/systemctl:start treeseed-sandbox-broker.service');
 expect(f.states).toEqual({manager:false,runner:false});
 expect(readFileSync(resolve(f.root,'runtime/capacity-state.json'),'utf8')).toBe(value);
});

it('restores broker runner and admissions when expired recovery still has physical work or an incomplete observation',()=>{
 const deadline=new Date(Date.now()-60_000).toISOString(),started=new Date(Date.now()-120_000).toISOString();
 const claim={id:'retained',assignmentId:'original-assignment',status:'recovery',leaseExpiresAt:deadline,activeStartedAt:started,
  dispatchEnvelope:{assignment:{assignmentAttempt:{schemaVersion:'treeseed.assignment-attempt/v1',id:'original-assignment',deadline}}}};
 vi.spyOn(configuration,'loadSandboxBrokerConfiguration').mockReturnValue({containerdAddress:'/run/containerd/containerd.sock',namespace:'treeseed-sandboxes'} as ReturnType<typeof configuration.loadSandboxBrokerConfiguration>);
 const vm=vi.spyOn(doctor,'inspectVmProcesses');
 for(const failure of ['tasks','containers','vm','unreadable','changed','producer']) {
  const value=JSON.stringify({schemaVersion:1,claims:[claim],usage:{unknown:99}}),f=fixture(value),effects:string[]=[];
  vm.mockReturnValue({processes:failure==='vm'?[{processId:1,startTicks:'1',executable:'/qemu',name:'sandbox-foreign',failure:null}]:[],pidNamespace:'pid:[1]',complete:failure!=='unreadable'});
  let lists=0;
  const transport=(executable:string,args:readonly string[])=>{
   if(executable.endsWith('docker')) {
    const service=(args[0]==='inspect'?args[1]:args.at(-1))!.includes('manager')?'manager':'runner';
    if(args[0]==='inspect')return JSON.stringify({labels:{'com.docker.compose.project':'treeseed-agent','com.docker.compose.service':service},running:f.states[service],environment:[]});
    f.states[service]=args[0]==='start';effects.push(`${args[0]}:${service}`);return '';
   }
   effects.push(`${executable}:${args.join(' ')}`);
	 if(executable.endsWith('systemctl')&&args[0]==='show')return failure==='producer'?'active\n':'inactive\n';
   if(executable.endsWith('ctr')){lists++;return args.includes(failure)||(failure==='changed'&&lists>2)?'remaining\n':'';}
   return '';
  };
  expect(()=>stopForHandoff(transport,f.root,()=>transport('/usr/bin/docker',['start','treeseed-agent-manager-1']))).toThrow(/requires/);
  expect(f.states).toEqual({manager:true,runner:true});
  expect(effects.slice(-3)).toEqual(['/usr/bin/systemctl:start treeseed-sandbox-broker.service','start:runner','start:manager']);
  expect(readFileSync(resolve(f.root,'runtime/capacity-state.json'),'utf8')).toBe(value);
 }
});

it('never fences a live or foreign recovery authority to make code handoff pass',()=>{
 const past=new Date(Date.now()-60_000).toISOString(),future=new Date(Date.now()+60_000).toISOString(),start=new Date(Date.now()-120_000).toISOString();
 const original={id:'held',assignmentId:'original',status:'recovery',activeStartedAt:start,leaseExpiresAt:past,
  dispatchEnvelope:{assignment:{assignmentAttempt:{schemaVersion:'treeseed.assignment-attempt/v1',id:'original',deadline:past}}}};
 for(const claim of [{...original,status:'running'},{...original,status:'ready'},{...original,leaseExpiresAt:future},
  {...original,dispatchEnvelope:{assignment:{assignmentAttempt:{...original.dispatchEnvelope.assignment.assignmentAttempt,deadline:future}}}},
  {...original,dispatchEnvelope:{assignment:{assignmentAttempt:{...original.dispatchEnvelope.assignment.assignmentAttempt,id:'foreign'}}}},
  {...original,dispatchEnvelope:undefined}]) {
  const value=JSON.stringify({schemaVersion:1,claims:[claim]}),f=fixture(value);
  expect(()=>f.run()).toThrow('cannot interrupt');expect(f.effects).toEqual(['stop:manager','start:manager']);
  expect(readFileSync(resolve(f.root,'runtime/capacity-state.json'),'utf8')).toBe(value);
 }
});

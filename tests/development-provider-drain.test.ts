import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { stopForHandoff } from '../src/supervisor/development-agent-container.js';
const temporary:string[]=[];
afterEach(()=>{for(const root of temporary.splice(0))rmSync(root,{recursive:true,force:true});});
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
  for(const value of [inventory('polling'),JSON.stringify({schemaVersion:1,claims:[]})]) {
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

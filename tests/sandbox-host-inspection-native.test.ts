import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSandboxBrokerConfiguration } from '../src/sandbox/configuration.js';
import type { inspectSandboxInventory } from '../src/sandbox/doctor.js';
import { containerdImageReference } from '../src/sandbox/image-reference.js';

type Inventory=Awaited<ReturnType<typeof inspectSandboxInventory>>;
it('native installed CLI manager and supervisor observe exact task container mount and directory presence and scoped absence while retaining unrelated resources',async()=>{
 if(process.env.TREESEED_PRIVILEGED_CACHE_TESTS!=='1'||process.getuid?.()!==0)
  throw new Error('Disposable privileged owning-host authorization required; public inspection cannot be skipped.');
 for(const path of ['src/sandbox/doctor.js','src/supervisor/execute.js','src/manager/operations.js'])
  expect(readFileSync(`/usr/lib/treeseed/manager/dist/${path}`)).toEqual(readFileSync(`dist/${path}`));
 const configuration=loadSandboxBrokerConfiguration(),suffix=randomUUID(),id=`sandbox-inspection-${suffix}`;
 const directory=join(configuration.stateRoot,id),unrelated=join(configuration.stateRoot,`sandbox-unrelated-${suffix}`);
 const source=mkdtempSync(join(tmpdir(),'sandbox-inspection-mount-')),mounted=join(directory,'mounted');
 const command=(path:string,args:string[])=>execFileSync(path,args,{encoding:'utf8',timeout:1000,maxBuffer:32*1024*1024});
 const ctr=(args:string[])=>command('/usr/bin/ctr',['--address',configuration.containerdAddress,'--namespace',configuration.namespace,...args]);
 const cli=await import('/usr/lib/treeseed/cli/dist/cli/runtime.js' as string) as {runCommandLine:(args:string[],options:{interactiveUi:boolean;write:(output:string)=>void})=>Promise<number>};
 expect(typeof cli.runCommandLine).toBe('function');
 const observations:Inventory[]=[],failures:unknown[]=[];
 const inspect=async()=>{
  const outputs:string[]=[];expect(await cli.runCommandLine(['host','sandbox','status','--json'],{interactiveUi:false,write:output=>outputs.push(output)})).toBe(0);
  expect(outputs).toHaveLength(1);const envelope=JSON.parse(outputs[0]!) as {ok:boolean;result:{inventory:Inventory}};
  expect(envelope.ok).toBe(true);const result=envelope.result.inventory;observations.push(result);
  expect(result.complete).toBe(true);expect(result.errors).toEqual([]);
  expect(result.scope.containerdAddress).toBe(configuration.containerdAddress);expect(result.scope.namespace).toBe(configuration.namespace);expect(result.scope.stateRoot).toBe(configuration.stateRoot);
  expect(result.tasks).toBe(result.confirmation.tasks);expect(result.containers).toBe(result.confirmation.containers);
  expect(result.mountInfo).toContain(' - ');expect(result.managedDirectory.rootPresent).toBe(true);return result;
 };
 let bound=false,attempted=false;
 try {
  mkdirSync(directory);mkdirSync(mounted);mkdirSync(unrelated);
  command('/usr/bin/mount',['--bind',source,mounted]);bound=true;
  const guest=configuration.guestImages[0];expect(guest).toBeDefined();
  const image=containerdImageReference(guest!.image,guest!.digest);
  expect(ctr(['containers','list','--quiet']).split('\n')).not.toContain(id);
  attempted=true;ctr(['run','--detach','--runtime','io.containerd.runc.v2',image,id,'/bin/sleep','60']);
  const present=await inspect();
  expect(present.tasks!.split('\n')).toContain(id);expect(present.containers!.split('\n')).toContain(id);
  expect(present.mountInfo).toContain(mounted);expect(present.managedDirectory.entries.map(entry=>entry.name)).toEqual(expect.arrayContaining([id,unrelated.split('/').at(-1)!]));
  ctr(['tasks','kill','--signal','SIGKILL',id]);ctr(['tasks','delete','--force',id]);ctr(['containers','delete',id]);attempted=false;
  command('/usr/bin/umount',[mounted]);bound=false;rmSync(directory,{recursive:true});
  const absent=await inspect();
  expect(absent.tasks!.split('\n')).not.toContain(id);expect(absent.containers!.split('\n')).not.toContain(id);expect(absent.mountInfo).not.toContain(mounted);
  expect(absent.managedDirectory.entries.map(entry=>entry.name)).not.toContain(id);
  expect(absent.managedDirectory.entries.map(entry=>entry.name)).toContain(unrelated.split('/').at(-1)!);
 } catch(error){failures.push(error);} finally {
  if(attempted){
   try{if(ctr(['tasks','list','--quiet']).split('\n').includes(id)){
    ctr(['tasks','kill','--signal','SIGKILL',id]);ctr(['tasks','delete','--force',id]);
   }}catch(error){failures.push(error);}
   try{if(ctr(['containers','list','--quiet']).split('\n').includes(id))ctr(['containers','delete',id]);}catch(error){failures.push(error);}
  }
  if(bound)try{command('/usr/bin/umount',[mounted]);bound=false;}catch(error){failures.push(error);}
  if(!bound)for(const path of [directory,unrelated,source])try{rmSync(path,{recursive:true,force:true});}catch(error){failures.push(error);}
  // Existing Actions logs retain original observations, including failed completeness.
  console.log(JSON.stringify({sandboxInspectionObservations:observations}));
 }
 if(failures.length)throw new AggregateError(failures,'Native public inspection failed; original and cleanup failures retained.');
});

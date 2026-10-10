import { expect, it, onTestFailed } from 'vitest';
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
 let phase='HOST_AUTHORITY',failedPhase:string|undefined;
 onTestFailed(()=>{throw new Error(`ACCEPTANCE_HOST_INSPECTION_${failedPhase??phase}: Original native failure; inspect retained owning observations.`);});
 if(process.env.TREESEED_PRIVILEGED_CACHE_TESTS!=='1'||process.getuid?.()!==0)
  throw new Error('Disposable privileged owning-host authorization required; public inspection cannot be skipped.');
 phase='INSTALLED_BYTES';
 for(const path of ['src/sandbox/doctor.js','src/supervisor/execute.js','src/manager/operations.js'])
  expect(readFileSync(`/usr/lib/treeseed/manager/dist/${path}`)).toEqual(readFileSync(`dist/${path}`));
 phase='OWNING_CONFIGURATION';const configuration=loadSandboxBrokerConfiguration(),suffix=randomUUID(),id=`sandbox-inspection-${suffix}`;
 const directory=join(configuration.stateRoot,id),unrelated=join(configuration.stateRoot,`sandbox-unrelated-${suffix}`);
 const source=mkdtempSync(join(tmpdir(),'sandbox-inspection-mount-')),mounted=join(directory,'mounted');
 const command=(path:string,args:string[])=>execFileSync(path,args,{encoding:'utf8',timeout:1000,maxBuffer:32*1024*1024});
 const ctr=(args:string[])=>command('/usr/bin/ctr',['--address',configuration.containerdAddress,'--namespace',configuration.namespace,...args]);
 phase='INSTALLED_CLI';const cli=await import('/usr/lib/treeseed/cli/dist/cli/runtime.js' as string) as {runCommandLine:(args:string[],options:{interactiveUi:boolean;write:(output:string)=>void})=>Promise<number>};
 expect(typeof cli.runCommandLine).toBe('function');
 const observations:Inventory[]=[],failures:unknown[]=[];
 const inspect=async()=>{
  const observationPhase=phase;phase=`${observationPhase}_COMMAND`;
  const outputs:string[]=[];expect(await cli.runCommandLine(['host','sandbox','status','--json'],{interactiveUi:false,write:output=>outputs.push(output)})).toBe(0);
  phase=`${observationPhase}_ENVELOPE`;
  expect(outputs).toHaveLength(1);const envelope=JSON.parse(outputs[0]!) as {ok:boolean;result:{inventory:Inventory}};
  expect(envelope.ok).toBe(true);const result=envelope.result.inventory;observations.push(result);
  phase=`${observationPhase}_COMPLETE`;expect(result.complete).toBe(true);expect(result.errors).toEqual([]);
  phase=`${observationPhase}_SCOPE`;
  expect(result.scope.containerdAddress).toBe(configuration.containerdAddress);expect(result.scope.namespace).toBe(configuration.namespace);expect(result.scope.stateRoot).toBe(configuration.stateRoot);
  phase=`${observationPhase}_CONFIRMATION`;expect(result.tasks!.trimEnd().split('\n').sort()).toEqual(result.confirmation.tasks!.trimEnd().split('\n').sort());
  expect(result.containers!.trimEnd().split('\n').sort()).toEqual(result.confirmation.containers!.trimEnd().split('\n').sort());
  phase=`${observationPhase}_DIRECTORY`;expect(result.mountInfo).toContain(' - ');expect(result.managedDirectory.rootPresent).toBe(true);phase=observationPhase;return result;
 };
 let bound=false,attempted=false;
 try {
  phase='PREPARATION';
  mkdirSync(directory);mkdirSync(mounted);mkdirSync(unrelated);
  command('/usr/bin/mount',['--bind',source,mounted]);bound=true;
  const guest=configuration.guestImages[0];expect(guest).toBeDefined();
  const image=containerdImageReference(guest!.image,guest!.digest);
  expect(ctr(['containers','list','--quiet']).split('\n')).not.toContain(id);
  phase='NATIVE_START';attempted=true;ctr(['run','--detach','--runtime','io.containerd.runc.v2',image,id,'/bin/sleep','60']);
  phase='PUBLIC_PRESENCE';
  const present=await inspect();
  expect(present.tasks!.split('\n')).toContain(id);expect(present.containers!.split('\n')).toContain(id);
  expect(present.mountInfo).toContain(mounted);expect(present.managedDirectory.entries.map(entry=>entry.name)).toEqual(expect.arrayContaining([id,unrelated.split('/').at(-1)!]));
  phase='NATIVE_STOP';ctr(['tasks','kill','--signal','SIGKILL',id]);ctr(['tasks','delete','--force',id]);ctr(['containers','delete',id]);attempted=false;
  phase='SCOPED_TEARDOWN';command('/usr/bin/umount',[mounted]);bound=false;rmSync(directory,{recursive:true});
  phase='PUBLIC_ABSENCE';const absent=await inspect();
  expect(absent.tasks!.split('\n')).not.toContain(id);expect(absent.containers!.split('\n')).not.toContain(id);expect(absent.mountInfo).not.toContain(mounted);
  expect(absent.managedDirectory.entries.map(entry=>entry.name)).not.toContain(id);
  expect(absent.managedDirectory.entries.map(entry=>entry.name)).toContain(unrelated.split('/').at(-1)!);
 } catch(error){failedPhase=phase;failures.push(error);} finally {
  phase='FINAL_CLEANUP';
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

import {sourceInspectionAuthority} from './source-inspection-authority-fixture.ts';
import { expect, it, onTestFailed } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSandboxBrokerConfiguration } from '../src/sandbox/configuration.js';
import type { inspectSandboxInventory } from '../src/sandbox/doctor.js';
import { containerdImageReference } from '../src/sandbox/image-reference.js';
import { attachWorkspaceDisk, detachWorkspaceDisk, type WorkspaceDisk, workspaceStorageRoot } from '../src/sandbox/workspace-block-store.js';
import { workspaceNbdServiceArguments } from '../src/sandbox/workspace-nbd-service.js';
import { setTimeout as delay } from 'node:timers/promises';
import { simulationSourceRepository } from '../src/sandbox/simulation-source-repository.js';
import type { workspaceStatus } from '../src/sandbox/workspace-status.js';

type Inventory=Awaited<ReturnType<typeof inspectSandboxInventory>>;
it('native installed CLI manager and supervisor observe exact task container mount and directory presence and scoped absence while retaining unrelated resources',async()=>{
 let phase='HOST_AUTHORITY',failedPhase:string|undefined;
 onTestFailed(()=>{throw new Error(`ACCEPTANCE_HOST_INSPECTION_${failedPhase??phase}: Original native failure; inspect retained owning observations.`);});
 if(process.env.TREESEED_PRIVILEGED_CACHE_TESTS!=='1'||process.getuid?.()!==0)
  throw new Error('Disposable privileged owning-host authorization required; public inspection cannot be skipped.');
 phase='INSTALLED_BYTES';
 for(const path of ['src/sandbox/doctor.js','src/sandbox/workspace-status.js','src/sandbox/directory-inspection.js','src/supervisor/execute.js','src/manager/operations.js'])
  expect(readFileSync(`/usr/lib/treeseed/manager/dist/${path}`)).toEqual(readFileSync(`dist/${path}`));
 phase='OWNING_CONFIGURATION';const configuration=loadSandboxBrokerConfiguration(),suffix=randomUUID(),id=`sandbox-inspection-${suffix}`;
 const directory=join(configuration.stateRoot,id),unrelated=join(configuration.stateRoot,`sandbox-unrelated-${suffix}`);
 const workspaceId=`workspace-lease-${suffix}`,unrelatedWorkspaceId=`workspace-lease-${randomUUID()}`;
 const workspace=join(workspaceStorageRoot,'leases',workspaceId),unrelatedWorkspace=join(workspaceStorageRoot,'leases',unrelatedWorkspaceId);
 const unrelatedSandboxId=`sandbox-unrelated-${suffix}`,journalPaths:string[]=[];
 const owner={assignmentId:`assignment-${suffix}`,providerId:'provider-inspection',teamId:'team-inspection',projectId:'project-inspection',attempt:1};
 const unrelatedOwner={...owner,assignmentId:`assignment-unrelated-${suffix}`,teamId:'team-unrelated'};
 const sourceKey={controlPlaneId:'inspection-control',teamId:owner.teamId,projectId:owner.projectId,repositoryId:`repository-${suffix}`,commit:'a'.repeat(40),formatVersion:1 as const,profile:'source-only' as const};
 const sourceReference={kind:'git',repository:'treeseed-ai/sdk',commit:'b'.repeat(40),branch:`simulation/${suffix}`};
 const simulationRepository=simulationSourceRepository(workspaceStorageRoot,sourceKey);
 const journal=(kind:string,sandbox:string,value:unknown)=>{
  const root=join(workspaceStorageRoot,kind);mkdirSync(root,{recursive:true,mode:0o700});
  const path=join(root,`${sandbox}.json`);if(!journalPaths.includes(path))journalPaths.push(path);
  writeFileSync(path,JSON.stringify(value),{mode:0o600});
 };
 const unknownWorkspaceId=`workspace-unknown-${suffix}`,unknownWorkspace=join(workspaceStorageRoot,'leases',unknownWorkspaceId);
 const source=mkdtempSync(join(tmpdir(),'sandbox-inspection-mount-')),mounted=join(directory,'mounted');
 const namespaceMount=join(unrelated,'network-namespace'),namespaceRoot=readlinkSync('/proc/1/ns/net');
 expect(namespaceRoot).toMatch(/^net:\[\d+\]$/u);
 const command=(path:string,args:string[])=>execFileSync(path,args,{encoding:'utf8',timeout:1000,maxBuffer:32*1024*1024});
 const ctr=(args:string[])=>command('/usr/bin/ctr',['--address',configuration.containerdAddress,'--namespace',configuration.namespace,...args]);
 phase='INSTALLED_CLI';const cli=await import('/usr/lib/treeseed/cli/dist/cli/runtime.js' as string) as {runCommandLine:(args:string[],options:{interactiveUi:boolean;write:(output:string)=>void})=>Promise<number>};
 expect(typeof cli.runCommandLine).toBe('function');
 const observations:Inventory[]=[],workspaceObservations:Array<ReturnType<typeof workspaceStatus>>=[],failures:unknown[]=[];
 const inspect=async()=>{
  const observationPhase=phase;phase=`${observationPhase}_COMMAND`;
  const outputs:string[]=[];expect(await cli.runCommandLine(['host','sandbox','status','--json'],{interactiveUi:false,write:output=>outputs.push(output)})).toBe(0);
  phase=`${observationPhase}_ENVELOPE`;
  expect(outputs).toHaveLength(1);const envelope=JSON.parse(outputs[0]!) as {ok:boolean;result:{runtime:string;inventory:Inventory;workspace:ReturnType<typeof workspaceStatus>}};
  expect(envelope.ok).toBe(true);const result=envelope.result.inventory;observations.push(result);
  const workspaceObservation=envelope.result.workspace;workspaceObservations.push(workspaceObservation);
  expect(workspaceObservation.scope.storageRoot).toBe(workspaceStorageRoot);
  expect(workspaceObservation.scope.mountNamespace).toBe(readlinkSync('/proc/1/ns/mnt'));
  expect(typeof workspaceObservation.complete).toBe('boolean');
  expect(workspaceObservation.journals).not.toBeNull();
  for(const sandbox of [id,unrelatedSandboxId]){
   if(sandbox===id&&observationPhase==='PUBLIC_JOURNAL_DENIAL'){
    expect(workspaceObservation.complete).toBe(false);expect(workspaceObservation.errors).toContain('workspace_jobs_metadata_unavailable');
    expect(workspaceObservation.journals!.jobs.entries).toContainEqual(expect.objectContaining({name:`${sandbox}.json`,metadata:null}));
   }else expect(workspaceObservation.journals!.jobs.entries)
    .toContainEqual(expect.objectContaining({name:`${sandbox}.json`,metadata:expect.objectContaining({owner:sandbox===id?owner:unrelatedOwner,state:'stopped'})}));
  }
  if(observationPhase==='PUBLIC_JOURNAL_RETRY')expect(workspaceObservation.errors).not.toContain('workspace_jobs_metadata_unavailable');
  expect(JSON.stringify(workspaceObservation)).not.toContain('controlled-private-journal-content');
  if(observationPhase==='PUBLIC_SOURCE_DENIAL'){
   expect(workspaceObservation.complete).toBe(false);expect(workspaceObservation.errors).toContain('workspace_results_metadata_unavailable');
   expect(workspaceObservation.journals!.results.entries).toContainEqual(expect.objectContaining({name:`${id}.json`,metadata:null}));
  }else expect(workspaceObservation.journals!.results.entries).toContainEqual(expect.objectContaining({name:`${id}.json`,
   metadata:expect.objectContaining({sandboxId:id,teardownVerified:true,source:sourceKey,sourceReference,simulationRepository})}));
  expect(workspaceObservation.journals!.candidates.entries).toContainEqual(expect.objectContaining({name:`${id}.json`,
   metadata:{state:'retained',assignmentId:owner.assignmentId}}));
  if(!workspaceObservation.initialized){expect(workspaceObservation.complete).toBe(false);expect(workspaceObservation.errors).toContain('workspace_catalog_unavailable');}
  const physicalIds=workspaceObservation.disks.map(disk=>disk.id);
  expect(physicalIds).toContain(unrelatedWorkspaceId);
  if(observationPhase==='PUBLIC_PRESENCE'){
   expect(workspaceObservation.disks).toContainEqual({id:workspaceId,type:'directory',bytes:4,device:null});
   expect(workspaceObservation.disks).toContainEqual({id:unknownWorkspaceId,type:'file',bytes:null,device:null});
   expect(workspaceObservation.complete).toBe(false);expect(workspaceObservation.errors).toContain('workspace_lease_metadata_unavailable');
   expect(JSON.stringify(workspaceObservation)).not.toContain('controlled-unrelated-content');
  }
  if(observationPhase==='PUBLIC_ABSENCE'){
   expect(physicalIds).not.toContain(workspaceId);expect(physicalIds).not.toContain(unknownWorkspaceId);
   expect(readFileSync(join(unrelatedWorkspace,'work.qcow2'),'utf8')).toBe('keep');
  }
  phase=`${observationPhase}_COMPLETE`;expect(result.complete).toBe(true);expect(result.errors).toEqual([]);
  phase=`${observationPhase}_SCOPE`;
  expect(result.scope.brokerSocket).toBe(configuration.socketPath);expect(envelope.result.runtime).toBe(configuration.runtime);
  expect(result.scope.containerdAddress).toBe(configuration.containerdAddress);expect(result.scope.namespace).toBe(configuration.namespace);expect(result.scope.stateRoot).toBe(configuration.stateRoot);
  phase=`${observationPhase}_CONFIRMATION`;expect(result.tasks!.trimEnd().split('\n').sort()).toEqual(result.confirmation.tasks!.trimEnd().split('\n').sort());
  expect(result.containers!.trimEnd().split('\n').sort()).toEqual(result.confirmation.containers!.trimEnd().split('\n').sort());
  phase=`${observationPhase}_DIRECTORY`;expect(result.mountInfo).toContain(' - ');expect(result.managedDirectory.rootPresent).toBe(true);phase=observationPhase;return result;
 };
 let bound=false,namespaceBound=false,attempted=false;
 try {
  phase='PREPARATION';
  mkdirSync(directory);mkdirSync(mounted);mkdirSync(unrelated);
  mkdirSync(workspace,{recursive:true});mkdirSync(unrelatedWorkspace);
  writeFileSync(join(workspace,'work.qcow2'),'disk');writeFileSync(join(unrelatedWorkspace,'work.qcow2'),'keep');
  // Controlled original-journal fixtures prove the read boundary, not source execution or settlement.
  for(const [sandbox,diskId,diskRoot] of [[id,workspaceId,workspace],[unrelatedSandboxId,unrelatedWorkspaceId,unrelatedWorkspace]])
   journal('jobs',sandbox!,{schemaVersion:'treeseed.assignment-source-job/v1',owner:sandbox===id?owner:unrelatedOwner,state:'stopped',leaseId:`lease-${sandbox}`,
    disk:{id:diskId,directory:diskRoot,image:join(diskRoot!,'work.qcow2'),device:'/dev/nbd99',unit:`treeseed-${diskId}.service`},
    authority:sourceInspectionAuthority(sandbox===id?owner:unrelatedOwner,sourceKey,sourceReference.branch),privateAuthorityArgument:'controlled-private-journal-content'});
  mkdirSync(simulationRepository,{recursive:true,mode:0o700});
  journal('results',id,{source:sourceKey,sourceReference,schemaVersion:'treeseed.source-result/v1',sandboxId:id,leaseId:`lease-${id}`,status:'completed',
   teardownVerified:true,completedAt:new Date().toISOString(),result:{private:'controlled-private-journal-content'}});
  journal('candidates',id,{state:'retained',assignmentId:owner.assignmentId,reason:'source_publication_failed',detail:'controlled-private-journal-content'});
  writeFileSync(join(workspace,'device.json'),'{');writeFileSync(unknownWorkspace,'controlled-unrelated-content');
  command('/usr/bin/mount',['--bind',source,mounted]);bound=true;
  writeFileSync(namespaceMount,'');command('/usr/bin/mount',['--bind','/proc/1/ns/net',namespaceMount]);namespaceBound=true;
  const guest=configuration.guestImages[0];expect(guest).toBeDefined();
  const image=containerdImageReference(guest!.image,guest!.digest);
  expect(ctr(['containers','list','--quiet']).split('\n')).not.toContain(id);
  phase='NATIVE_START';attempted=true;ctr(['run','--detach','--runtime','io.containerd.runc.v2',image,id,'/bin/sleep','60']);
  phase='PUBLIC_PRESENCE';
  const present=await inspect();
  expect(present.tasks!.split('\n')).toContain(id);expect(present.containers!.split('\n')).toContain(id);
  expect(present.mountInfo!.split('\n').some(line=>{const fields=line.split(' ');return fields[3]===namespaceRoot&&fields[4]===namespaceMount&&fields[fields.indexOf('-')+1]==='nsfs';})).toBe(true);
  expect(present.mountInfo).toContain(mounted);expect(present.managedDirectory.entries.map(entry=>entry.name)).toEqual(expect.arrayContaining([id,unrelated.split('/').at(-1)!]));
  phase='NATIVE_STOP';ctr(['tasks','kill','--signal','SIGKILL',id]);ctr(['tasks','delete','--force',id]);ctr(['containers','delete',id]);attempted=false;
  phase='SCOPED_TEARDOWN';command('/usr/bin/umount',[mounted]);bound=false;rmSync(directory,{recursive:true});rmSync(workspace,{recursive:true});rmSync(unknownWorkspace);
  phase='PUBLIC_ABSENCE';const absent=await inspect();
  expect(absent.tasks!.split('\n')).not.toContain(id);expect(absent.containers!.split('\n')).not.toContain(id);expect(absent.mountInfo).not.toContain(mounted);
  expect(absent.managedDirectory.entries.map(entry=>entry.name)).not.toContain(id);
  expect(absent.managedDirectory.entries.map(entry=>entry.name)).toContain(unrelated.split('/').at(-1)!);
  expect(absent.mountInfo).toContain(namespaceMount);expect(readlinkSync('/proc/1/ns/net')).toBe(namespaceRoot);
  const originalJob=readFileSync(join(workspaceStorageRoot,'jobs',`${id}.json`));
  writeFileSync(join(workspaceStorageRoot,'jobs',`${id}.json`),'{');phase='PUBLIC_JOURNAL_DENIAL';await inspect();
  expect(readFileSync(join(workspaceStorageRoot,'jobs',`${id}.json`),'utf8')).toBe('{');
  writeFileSync(join(workspaceStorageRoot,'jobs',`${id}.json`),originalJob);phase='PUBLIC_JOURNAL_RETRY';await inspect();
  expect(readFileSync(join(workspaceStorageRoot,'jobs',`${id}.json`))).toEqual(originalJob);
  const resultPath=join(workspaceStorageRoot,'results',`${id}.json`),originalResult=readFileSync(resultPath);
  const resultRecord=JSON.parse(originalResult.toString()) as Record<string,unknown>;
  for(const malformed of [{...resultRecord,source:{...sourceKey,commit:'invalid'}},
   {...resultRecord,sourceReference:{kind:'url',url:'https://example.invalid/'}},{...resultRecord,source:undefined}]){
   writeFileSync(resultPath,JSON.stringify(malformed));const failedResult=readFileSync(resultPath);
   phase='PUBLIC_SOURCE_DENIAL';await inspect();expect(readFileSync(resultPath)).toEqual(failedResult);
  }
  writeFileSync(resultPath,originalResult);phase='PUBLIC_SOURCE_RETRY';await inspect();expect(readFileSync(resultPath)).toEqual(originalResult);
 } catch(error){failedPhase=phase;failures.push(error);} finally {
  phase='FINAL_CLEANUP';
  try{rmSync(simulationRepository,{recursive:true,force:true});}catch(error){failures.push(error);}
  if(attempted){
   try{if(ctr(['tasks','list','--quiet']).split('\n').includes(id)){
    ctr(['tasks','kill','--signal','SIGKILL',id]);ctr(['tasks','delete','--force',id]);
   }}catch(error){failures.push(error);}
   try{if(ctr(['containers','list','--quiet']).split('\n').includes(id))ctr(['containers','delete',id]);}catch(error){failures.push(error);}
  }
  if(bound)try{command('/usr/bin/umount',[mounted]);bound=false;}catch(error){failures.push(error);}
  if(namespaceBound)try{command('/usr/bin/umount',[namespaceMount]);namespaceBound=false;}catch(error){failures.push(error);}
  if(!bound&&!namespaceBound)for(const path of [directory,unrelated,source,workspace,unrelatedWorkspace,unknownWorkspace])try{rmSync(path,{recursive:true,force:true});}catch(error){failures.push(error);}
  for(const path of journalPaths)try{rmSync(path,{force:true});}catch(error){failures.push(error);}
  // Existing Actions logs retain original observations, including failed completeness.
  console.log(JSON.stringify({sandboxInspectionObservations:observations,workspaceInspectionObservations:workspaceObservations}));
 }
 if(failures.length)throw new AggregateError(failures,'Native public inspection failed; original and cleanup failures retained.');
});

it('native installed CLI manager and supervisor retain unrelated NBD transports while observing exact scoped image attachment and detach',async()=>{
 let phase='HOST_AUTHORITY';onTestFailed(()=>{throw new Error(`ACCEPTANCE_HOST_INSPECTION_${phase}: Original NBD observation failure retained.`);});
 if(process.env.TREESEED_PRIVILEGED_CACHE_TESTS!=='1'||process.getuid?.()!==0)
  throw new Error('Disposable privileged owning-host authorization required; public inspection cannot be skipped.');
 const configuration=loadSandboxBrokerConfiguration();
 expect(readFileSync('/usr/lib/treeseed/manager/dist/src/sandbox/doctor.js')).toEqual(readFileSync('dist/src/sandbox/doctor.js'));
 const command=(path:string,args:string[])=>execFileSync(path,args,{encoding:'utf8',timeout:1000,maxBuffer:32*1024*1024});
 const nbdLeases=[randomUUID(),randomUUID()].map(value=>{
  const id=`workspace-lease-${value}`,directory=join(workspaceStorageRoot,'leases',id);
  return {id,directory,image:join(directory,'work.qcow2')};
 });
 const attached=new Map<string,WorkspaceDisk>(),released=new Set<string>();
 const originalImages=new Map<string,Buffer>();
 const nativeNbd=(disk:WorkspaceDisk)=>{
  const threadId=Number(readFileSync(`/sys/block/${disk.device.slice(5)}/pid`,'utf8').trim());
  const processId=Number(readFileSync(join(disk.directory,'nbd.pid'),'utf8').trim());
  expect(Number.isSafeInteger(threadId)&&threadId>0).toBe(true);expect(Number.isSafeInteger(processId)&&processId>0).toBe(true);
  expect(readFileSync(`/proc/${threadId}/status`,'utf8').match(/^Tgid:\s+([0-9]+)$/mu)?.[1]).toBe(String(processId));
  expect(readlinkSync(`/proc/${processId}/exe`)).toBe('/usr/bin/qemu-nbd');
  return {device:disk.device,threadId,processId,executable:'/usr/bin/qemu-nbd',image:disk.image,failure:null};
 };
 const observations:Inventory[]=[],failures:unknown[]=[];
 const cli=await import('/usr/lib/treeseed/cli/dist/cli/runtime.js' as string) as {runCommandLine:(args:string[],options:{interactiveUi:boolean;write:(output:string)=>void})=>Promise<number>};
 const inspect=async()=>{
  const outputs:string[]=[];expect(await cli.runCommandLine(['host','sandbox','status','--json'],{interactiveUi:false,write:output=>outputs.push(output)})).toBe(0);
  expect(outputs).toHaveLength(1);const envelope=JSON.parse(outputs[0]!) as {ok:boolean;result:{inventory:Inventory}};
  expect(envelope.ok).toBe(true);const result=envelope.result.inventory;observations.push(result);
  expect(result.complete).toBe(true);expect(result.errors).toEqual([]);expect(result.scope.brokerSocket).toBe(configuration.socketPath);
  const devices=result.nbdDevices;expect(Array.isArray(devices)).toBe(true);if(!devices)throw new Error('Complete kernel inventory required');
  expect(devices.map(value=>value.device).sort()).toEqual(readdirSync('/sys/block').filter(name=>/^nbd[0-9]+$/u.test(name)).map(name=>'/dev/'+name).sort());
  expect(result.confirmation.nbdDevices).toEqual(devices);
  expect(JSON.stringify(result)).not.toContain('controlled-private-nbd-description');
  for(const disk of attached.values()){
   if(released.has(disk.id))expect(devices).toContainEqual({device:disk.device,threadId:null,processId:null,executable:null,image:null,failure:null});
   else expect(devices).toContainEqual(nativeNbd(disk));
   expect(readFileSync(disk.image)).toEqual(originalImages.get(disk.id));
  }
 };
 try{
  phase='NATIVE_NBD_PREPARATION';
  mkdirSync(join(workspaceStorageRoot,'devices'),{recursive:true,mode:0o700});
  for(const lease of nbdLeases){
   mkdirSync(lease.directory,{recursive:true,mode:0o700});
   command('/usr/bin/qemu-img',['create','-f','qcow2',lease.image,'1M']);
   originalImages.set(lease.id,readFileSync(lease.image));
   phase='NATIVE_NBD_ATTACH';attached.set(lease.id,await attachWorkspaceDisk(lease,true));
  }
  // Reconfigure only the fixture's independently fenced unrelated transport.
  // No VM ever used it; preserve disk/fence ownership and use the original argument builder.
  const other=attached.get(nbdLeases[1]!.id)!;phase='NATIVE_NBD_ARGUMENT_REPLAY';
  command('/usr/bin/systemctl',['stop',other.unit]);
  let vacant=false;
  for(let attempt=0;attempt<100;attempt++){
   const state=command('/usr/bin/systemctl',['show',other.unit,'--property=LoadState','--value']).trim();
   const names=readdirSync('/sys/block/'+other.device.slice(5));
   if(state==='not-found'&&!names.includes('pid')){vacant=true;break;}await delay(10);
  }
  expect(vacant).toBe(true);
  const service=workspaceNbdServiceArguments({...other,image:'work.qcow2',readOnly:true}),args=[...service.args];
  const originalImage=args.pop()!;expect(originalImage).toBe(other.image);
  args.splice(args.indexOf('/usr/bin/qemu-nbd')+1,0,originalImage);
  args.push('--description','controlled-private-nbd-description');command('/usr/bin/systemd-run',args);
  phase='PUBLIC_NBD_PRESENCE';await inspect();
  // Neither read-only fixture ever had a VM. Release only this fixture's owned transport.
  phase='SCOPED_NBD_TEARDOWN';const own=attached.get(nbdLeases[0]!.id)!;await detachWorkspaceDisk(own,true);released.add(own.id);
  phase='PUBLIC_NBD_ABSENCE';await inspect();
 }catch(error){failures.push(error);}finally{
  for(const lease of nbdLeases){
   try{
    let disk=attached.get(lease.id);
    if(!disk){
     try{const record=JSON.parse(readFileSync(join(lease.directory,'device.json'),'utf8')) as {id:string;device:string};
      expect(record.id).toBe(lease.id);disk={...lease,device:record.device,unit:`treeseed-${lease.id}.service`};
     }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    if(disk&&!released.has(lease.id)){await detachWorkspaceDisk(disk,true);released.add(lease.id);}
    // Keep image and fence on any ambiguous transport failure.
    rmSync(lease.directory,{recursive:true,force:true});
   }catch(error){failures.push(error);}
  }
  console.log(JSON.stringify({nativeNbdInspectionObservations:observations}));
 }
 if(failures.length)throw new AggregateError(failures,'Native NBD inspection or scoped fixture cleanup failed.');
});

it('native installed CLI manager and supervisor observe actual pinned QEMU process presence and scoped absence while retaining an unrelated VM',async()=>{
 onTestFailed(()=>{if(process.env.TREESEED_PRIVILEGED_CACHE_TESTS!=='1'||process.getuid?.()!==0)throw new Error('ACCEPTANCE_HOST_INSPECTION_HOST_AUTHORITY: Original denied VM inspection retained.');});
 if(process.env.TREESEED_PRIVILEGED_CACHE_TESTS!=='1'||process.getuid?.()!==0)throw new Error('Disposable privileged owning-host authorization required; VM inspection cannot be skipped.');
 expect(readFileSync('/usr/lib/treeseed/manager/dist/src/sandbox/doctor.js')).toEqual(readFileSync('dist/src/sandbox/doctor.js'));
 const configuration=loadSandboxBrokerConfiguration(),own='sandbox-inspection-'+randomUUID(),unrelated='sandbox-unrelated-'+randomUUID();
 const children:Array<{child:ChildProcess;closed:boolean}>=[],observations:Inventory[]=[],failures:unknown[]=[];
 const cli=await import('/usr/lib/treeseed/cli/dist/cli/runtime.js' as string) as {runCommandLine:(args:string[],options:{interactiveUi:boolean;write:(output:string)=>void})=>Promise<number>};
 const inspect=async()=>{
  const outputs:string[]=[];expect(await cli.runCommandLine(['host','sandbox','status','--json'],{interactiveUi:false,write:value=>outputs.push(value)})).toBe(0);expect(outputs).toHaveLength(1);
  const envelope=JSON.parse(outputs[0]!) as {ok:boolean;result:{inventory:Inventory}};expect(envelope.ok).toBe(true);const result=envelope.result.inventory;observations.push(result);
  expect(result.complete).toBe(true);expect(result.errors).toEqual([]);expect(Reflect.get(result.scope,'pidNamespace')).toBe(readlinkSync('/proc/1/ns/pid'));
  expect(result.scope.namespace).toBe(configuration.namespace);expect(Reflect.get(result,'vmProcesses')).toEqual(Reflect.get(result.confirmation,'vmProcesses'));
  return Reflect.get(result,'vmProcesses') as Array<{processId:number;startTicks:string;executable:string;name:string;failure:null}>;
 };
 const start=async(name:string)=>{
  // The already qualified disposable host owns actual KVM_CREATE_VM support.
  // This real pinned QEMU process proves inspection, not a managed guest/model.
  const child=spawn('/opt/kata/bin/qemu-system-x86_64',['-machine','none','-accel','kvm','-m','32M','-nodefaults','-nographic','-S','-name','sandbox-'+name],{stdio:['ignore','ignore','pipe']});
  const state={child,closed:false};children.push(state);child.once('close',()=>{state.closed=true;});let stderr='';child.stderr?.on('data',(value:Buffer)=>{stderr+=value.toString();});
  await new Promise<void>((done,reject)=>{child.once('spawn',done);child.once('error',reject);});await delay(30);expect(state.closed,stderr).toBe(false);expect(child.pid).toBeGreaterThan(0);return state;
 };
 const stop=async(state:typeof children[number])=>{
  if(state.closed)return;state.child.kill('SIGTERM');
  await new Promise<void>((done,reject)=>{const kill=setTimeout(()=>{if(!state.closed)state.child.kill('SIGKILL');},1000),deadline=setTimeout(()=>{clearTimeout(kill);reject(new Error('Original five-second owned QEMU stop bound elapsed'));},5000);
   state.child.once('close',()=>{clearTimeout(kill);clearTimeout(deadline);done();});});expect(state.closed).toBe(true);
 };
 try{
  const selected=await start(own),other=await start(unrelated),present=await inspect();
  for(const [state,name]of [[selected,own],[other,unrelated]] as const){const exact=present.filter(row=>row.processId===state.child.pid);expect(exact).toHaveLength(1);expect(exact[0]).toMatchObject({name:'sandbox-'+name,failure:null,startTicks:expect.stringMatching(/^[1-9][0-9]*$/u)});}
  await stop(selected);const absent=await inspect();expect(absent.some(row=>row.processId===selected.child.pid||row.name==='sandbox-'+own)).toBe(false);
  expect(absent.find(row=>row.processId===other.child.pid)).toEqual(present.find(row=>row.processId===other.child.pid));expect(other.closed).toBe(false);
  const replay=await inspect();expect(replay.find(row=>row.processId===other.child.pid)).toEqual(absent.find(row=>row.processId===other.child.pid));
 }catch(error){failures.push(error);}finally{
  for(const state of children)try{await stop(state);}catch(error){failures.push(error);}
  console.log(JSON.stringify({nativeQemuInspectionObservations:observations,ownedProcessCleanup:children.map(state=>({pid:state.child.pid,closed:state.closed}))}));
 }
 if(failures.length)throw new AggregateError(failures,'Native VM inspection or owned cleanup failed; original observations retained.');
});

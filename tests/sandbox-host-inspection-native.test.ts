import { expect, it, onTestFailed } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSandboxBrokerConfiguration } from '../src/sandbox/configuration.js';
import type { inspectSandboxInventory } from '../src/sandbox/doctor.js';
import { containerdImageReference } from '../src/sandbox/image-reference.js';
import { workspaceStorageRoot } from '../src/sandbox/workspace-block-store.js';
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
  const devices=Reflect.get(result,'nbdDevices');expect(Array.isArray(devices)).toBe(true);
  if(!Array.isArray(devices))throw new Error('Complete original kernel NBD inventory required');
  expect(devices.map(value=>value.device).sort()).toEqual(readdirSync('/sys/block').filter(name=>/^nbd[0-9]+$/u.test(name)).map(name=>'/dev/'+name).sort());
  expect(Reflect.get(result.confirmation,'nbdDevices')).toEqual(devices);

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
    authority:{private:'controlled-private-journal-content'}});
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

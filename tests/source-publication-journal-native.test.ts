import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SourcePublicationJob} from '../src/sandbox/source-publication-job.js';
import {simulationSourceRepository} from '../src/sandbox/simulation-source-repository.js';
import {workspaceStorageRoot} from '../src/sandbox/workspace-block-store.js';
import type {SourceWorkspaceAuthorization} from '@treeseed/sdk/capacity-provider/sandbox';
import type {workspaceStatus} from '../src/sandbox/workspace-status.js';

it('native publication and installed CLI manager supervisor preserve exact successful and failed candidate verification without changing local Git or unrelated custody on readback',async()=>{
 if(process.env.TREESEED_PRIVILEGED_CACHE_TESTS!=='1'||process.getuid?.()!==0)throw new Error('Disposable privileged owning-host authorization required; native publication observations cannot be skipped.');
 for(const path of ['src/sandbox/workspace-status.js','src/sandbox/directory-inspection.js','src/supervisor/execute.js','src/manager/operations.js'])expect(readFileSync('/usr/lib/treeseed/manager/dist/'+path)).toEqual(readFileSync('dist/'+path));
 const suffix=randomUUID(),root=mkdtempSync(join(tmpdir(),'publication-journal-native-')),work=join(root,'work'),journalRoot=join(workspaceStorageRoot,'candidates'),journals:string[]=[],observations:unknown[]=[];
 mkdirSync(work);mkdirSync(journalRoot,{recursive:true,mode:0o700});
 const git=(directory:string,...args:string[])=>execFileSync('/usr/bin/git',['-C',directory,...args],{encoding:'utf8',timeout:5000,maxBuffer:1024*1024,env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Native controlled source',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Native controlled source',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}}).trim();
 git(work,'init','--template=');writeFileSync(join(work,'source.ts'),'export const value=1;\n');git(work,'add','.');git(work,'commit','-m','controlled original base');const base=git(work,'rev-parse','HEAD');
 writeFileSync(join(work,'source.ts'),'export const value=2;\n');git(work,'add','.');git(work,'commit','-m','controlled candidate');const commit=git(work,'rev-parse','HEAD');
 const source={controlPlaneId:'native-publication',teamId:'team-'+suffix,projectId:'project-'+suffix,repositoryId:'treeseed-ai/sdk',commit:base,formatVersion:1 as const,profile:'source-only' as const},repository=simulationSourceRepository(workspaceStorageRoot,source);
 const cli=await import('/usr/lib/treeseed/cli/dist/cli/runtime.js' as string)as{runCommandLine:(args:string[],options:{interactiveUi:boolean;write:(value:string)=>void})=>Promise<number>};
 try{
  mkdirSync(repository,{recursive:true,mode:0o700});git(repository,'init','--bare','--template=');git(repository,'fetch',work,commit);const objectBytes=git(repository,'show',commit+':source.ts');
  for(const failed of [false,true]){
   const assignmentId='assignment-'+suffix+'-'+String(failed),sandboxId='sandbox-'+suffix+'-'+String(failed),path=join(journalRoot,sandboxId+'.json'),now=new Date();journals.push(path);
   const authorization:SourceWorkspaceAuthorization={schemaVersion:'treeseed.source-workspace-authorization/v1',id:'authorization-'+suffix,providerId:'native-provider',assignmentId,attempt:1,source,mode:'work',acquisition:'upstream-public',publication:'simulation-branch',publicationRef:'simulation/'+suffix+'/workday/'+assignmentId,issuedAt:now.toISOString(),expiresAt:new Date(now.getTime()+60_000).toISOString()};
   const verification={baseCommit:base,commit,bytes:Buffer.byteLength(objectBytes),clean:true as const,objectClosure:true as const,ancestry:true as const,isolatedVerifier:true as const},digest='sha256:'+createHash('sha256').update(objectBytes).digest('hex'),leaseId='lease-'+suffix,verifierId='sandbox-warm-'+suffix;
   const states:Array<Record<string,unknown>>=[];
   const job=new SourcePublicationJob({assignmentId,providerId:authorization.providerId,attempt:1},commit,4096,true,{
    current:()=>({leaseId,authorization,disk:{id:'controlled-disk',directory:root,image:join(root,'controlled.qcow2'),device:'/dev/nbd0',unit:'controlled.service'}}),now:()=>now,detachExecution:async()=>{},
    verify:async()=>({verification,bundlePath:join(root,'controlled.bundle'),digest,verifierStopped:true,verifierId}),
    journal:async value=>{states.push(structuredClone(value));writeFileSync(path,JSON.stringify(value),{mode:0o600});},
    publish:async()=>{if(failed)throw new Error('retained native controlled publication denial');git(repository,'update-ref','refs/heads/'+authorization.publicationRef,commit);return{kind:'git',repository:'treeseed-ai/sdk',commit,branch:authorization.publicationRef!};},
   });await job.drain();
   const held=readFileSync(path),original=JSON.parse(held.toString())as Record<string,unknown>,expected={state:failed?'retained':'published',assignmentId,attempt:1,providerId:authorization.providerId,leaseId,source,commit,verification,digest,verifierId,verifierStopped:true};expect(original).toMatchObject(expected);
   const refs=git(repository,'show-ref');
   const inspect=async()=>{const outputs:string[]=[];expect(await cli.runCommandLine(['host','sandbox','status','--json'],{interactiveUi:false,write:value=>outputs.push(value)})).toBe(0);expect(outputs).toHaveLength(1);const envelope=JSON.parse(outputs[0]!)as{ok:boolean;result:{workspace:ReturnType<typeof workspaceStatus>}};expect(envelope.ok).toBe(true);const observed=envelope.result.workspace,journal=observed.journals!.candidates.entries.filter(value=>value.name===sandboxId+'.json');expect(journal).toHaveLength(1);expect(journal[0]!.metadata).toEqual(expected);expect(observed.confirmation.journals).toEqual(observed.journals);observations.push(journal[0]);};
   await inspect();await inspect();await job.drain();expect(readFileSync(path)).toEqual(held);expect(git(repository,'show-ref')).toBe(refs);expect(git(repository,'show',commit+':source.ts')).toBe(objectBytes);expect(states.at(-1)).toEqual(original);
   if(failed){expect(job.publishedReference()).toBeUndefined();expect(original.detail).toBe('retained native controlled publication denial');}else expect(git(repository,'rev-parse','refs/heads/'+authorization.publicationRef)).toBe(commit);
  }
  // Actual owning publication orchestration, physical native Git/journal bytes,
  // and installed public CLI→manager→supervisor reads. Verification/detach
  // inputs are controlled DTOs; this is not Kata verification, API admission,
  // model execution, measured usage or a managed campaign receipt.
 }finally{
  console.log(JSON.stringify({nativePublicationJournalObservations:observations}));for(const path of journals)rmSync(path,{force:true});rmSync(repository,{recursive:true,force:true});rmSync(root,{recursive:true,force:true});
 }
},30_000);

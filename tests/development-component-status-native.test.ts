import {execFileSync} from 'node:child_process';
import {createReadStream,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {Writable} from 'node:stream';
import {developmentSessionSchema} from '@treeseed/sdk/development';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {expect,it,onTestFailed} from 'vitest';
import {managedComponentStatus,renderManagedComponentOverride,waitForManagedReadiness} from '../src/supervisor/development-component-container.js';
import {resolveDevelopmentRuntimeImage} from '../src/supervisor/development-container.js';
import {beginDevelopmentBackup,finishDevelopmentBackup,planDevelopmentBackup,type DevelopmentBackupDependencies} from '../src/supervisor/development-backup.js';
import {quiescedBackup} from '../src/manager/quiesced-backup.js';
import {assertNoBackupWriters} from '../src/supervisor/backup-writers.js';
import {encryptBackupStream,decryptBackupStream} from '../src/supervisor/backup-stream.js';
import {component} from './fixtures.js';

function fixture(timings: {operation:string;milliseconds:number}[] = []) {
 const root=mkdtempSync(resolve(tmpdir(),'managed-image-status-')),project=`image-custody-${process.pid}-${root.split('-').at(-1)}`;
 const input={sessionId:`dev-native-${process.pid}`,projectId:'treedx' as const,targetId:'service' as const,action:'status' as const};
 const override=resolve(root,'compose.json'),ids:string[]=[];
 const docker=(_executable:string,args:readonly string[])=>{
  const start=performance.now();
  try{return execFileSync('/usr/bin/docker',[...args],{encoding:'utf8',timeout:180000,stdio:['ignore','pipe','pipe']});}
  finally{timings.push({operation:args[0]!,milliseconds:Math.round(performance.now()-start)});}
 };
 const image=resolveDevelopmentRuntimeImage(docker);
 const select=(images=new Map([['treedx',image]]))=>writeFileSync(override,JSON.stringify(renderManagedComponentOverride(input,images)),{mode:0o600});
 select();
 const create=(service='treedx',sessionId=input.sessionId,writableRoot?:string)=>{
  const id=docker('/usr/bin/docker',['run','--detach','--read-only','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges:true',
   '--label',`com.docker.compose.project=${project}`,'--label',`com.docker.compose.service=${service}`,
   '--label',`org.treeseed.development.session=${sessionId}`,'--label','org.treeseed.development.target=treedx.service',
   ...(writableRoot?['--mount',`type=bind,source=${writableRoot},target=/data`]:[]),
   image,'node','-e','setInterval(()=>{},1000)']).trim();ids.push(id);return id;
 };
 const status=()=>managedComponentStatus(input,project,override,docker);
 return {root,project,input,override,image,ids,docker,create,select,status,
  close(){try{for(const id of ids)docker('/usr/bin/docker',['rm','--force',id]);}finally{rmSync(root,{recursive:true,force:true});}}};
}

it('binds real Docker image identity to the native selected file and rejects digest drift',({signal})=>{
 const timings:{operation:string;milliseconds:number}[]=[];
 // Preserve the original failure and watchdog. Observe only Docker operation
 // names and native elapsed time, never arguments, output or credentials.
 onTestFailed(()=>{throw new Error(`ACCEPTANCE_NATIVE_COMPONENT_IMAGE_${signal.aborted?'WATCHDOG':'FAILURE'}: ${JSON.stringify(timings)}`);});
 const f=fixture(timings);try {
  f.create();expect(f.status()).toMatchObject({registered:true,ready:true});
  f.select(new Map([['treedx',`sha256:${'0'.repeat(64)}`]]));expect(f.status).toThrow();
 }finally{f.close();}
});

it('native managed writer reaches encrypted backup only after owning quiescence and resumes the same selected image without residue',async()=>{
 const f=fixture(),key=randomBytes(32);try{
  const data=resolve(f.root,'data'),dir=resolve(f.root,f.input.sessionId,'treedx','service');mkdirSync(data);mkdirSync(dir,{recursive:true});
  const payload=Buffer.from('native managed state\n\0retained bytes'),file=resolve(data,'state');writeFileSync(file,payload);
  const path=resolve(dir,'compose.json'),spec=readFileSync(f.override);writeFileSync(path,spec,{mode:0o600});
  const id=f.create('treedx',f.input.sessionId,data),installed=component('treedx','development','d');
  installed.runtime.compose.projectName=f.project;installed.runtime.services[0]!.composeService='treedx';
  const session=developmentSessionSchema.parse({schemaVersion:'treeseed.development-session/v1',sessionId:f.input.sessionId,
   actor:'native-test',hostId:'native-host',createdAt:new Date().toISOString(),status:'active',repositories:[],
   targets:[{projectId:'treedx',targetId:'service',mode:'live',generation:1,health:'ready'}],leases:[],restoredReceiptId:null,blockers:[]});
  const record={session,runtimes:[],routes:[],candidates:[]};
  const deps:DevelopmentBackupDependencies={command:f.docker,records:()=>[record],components:()=>[installed],members:()=>[data.slice(1)],
   holdPath:resolve(f.root,'hold.json'),runtimeRoot:f.root,ownerUid:process.getuid!()};
  expect(f.status()).toMatchObject({ready:true});expect(()=>assertNoBackupWriters(deps.members(),args=>f.docker('/usr/bin/docker',args))).toThrow();
  expect(planDevelopmentBackup(deps)).toEqual([]);
  const selection=JSON.stringify(record);
  for(const mutate of [()=>{session.targets[0]!.mode='released';},()=>{writeFileSync(path,'not json');},
   ()=>{writeFileSync(path,JSON.stringify(renderManagedComponentOverride(f.input,new Map([['treedx',`sha256:${'0'.repeat(64)}`]]))),{mode:0o600});}]){
   mutate();expect(()=>beginDevelopmentBackup(1,deps)).toThrow();expect(existsSync(deps.holdPath)).toBe(false);
   expect(f.docker('/usr/bin/docker',['inspect',id,'--format','{{.State.Running}}']).trim()).toBe('true');
   session.targets[0]!.mode='live';writeFileSync(path,spec,{mode:0o600});
  }
  await quiescedBackup([installed],[installed],{
   prepare:async()=>beginDevelopmentBackup(1,deps),
   stop:async()=>{f.docker('/usr/bin/docker',['stop','--time','1',id]);},
   start:async()=>{f.docker('/usr/bin/docker',['start',id]);},
   capture:async()=>{
    assertNoBackupWriters(deps.members(),args=>f.docker('/usr/bin/docker',args));
    expect(()=>beginDevelopmentBackup(2,deps)).toThrow('interrupted');
    const encrypted=resolve(f.root,'state.enc'),chunks:Buffer[]=[];
    await encryptBackupStream(createReadStream(file),encrypted,1,key);
    await decryptBackupStream(encrypted,1,key,new Writable({write(chunk:Buffer,_encoding,next){chunks.push(Buffer.from(chunk));next();}}));
    expect(Buffer.concat(chunks)).toEqual(payload);expect(readFileSync(file)).toEqual(payload);
   },
  });
  expect(f.docker('/usr/bin/docker',['inspect',id,'--format','{{.State.Running}}']).trim()).toBe('false');
  expect(finishDevelopmentBackup(1,deps)).toEqual({resumed:true,generation:1,targets:0});
  f.docker('/usr/bin/docker',['start',id]);expect(f.status()).toMatchObject({ready:true});
  expect(f.docker('/usr/bin/docker',['inspect',id,'--format','{{.Image}}']).trim()).toBe(f.image);
  expect(readFileSync(path)).toEqual(spec);expect(JSON.stringify(record)).toBe(selection);expect(existsSync(deps.holdPath)).toBe(false);
 }finally{
  key.fill(0);f.close();expect(existsSync(f.root)).toBe(false);
  for(const id of f.ids)expect(f.docker('/usr/bin/docker',['ps','--all','--quiet','--filter',`id=${id}`]).trim()).toBe('');
 }
});
it('rejects real duplicate and incorrectly owned Docker instances without changing selection',()=>{
 const f=fixture();try{
  const first=f.create(),before=readFileSync(f.override);f.create();expect(f.status).toThrow();
  f.docker('/usr/bin/docker',['rm','--force',first]);f.ids.splice(f.ids.indexOf(first),1);
  f.create('treedx','dev-other');expect(f.status).toThrow();expect(readFileSync(f.override)).toEqual(before);
 }finally{f.close();}
});
it('requires all native selected persistent images while preserving completed one-shot exclusion',()=>{
 const f=fixture();try{
  f.create();f.select(new Map([['treedx',f.image],['worker',f.image]]));expect(f.status()).toMatchObject({ready:false});
  const worker=f.create('worker');expect(f.status()).toMatchObject({ready:true});f.docker('/usr/bin/docker',['stop','--time','1',worker]);
  expect(f.status()).toMatchObject({ready:false});f.docker('/usr/bin/docker',['rm',worker]);f.ids.splice(f.ids.indexOf(worker),1);
  f.select(new Map([['treedx',f.image],['inference-migrations',f.image]]));expect(f.status()).toMatchObject({ready:true});
  const completed=f.create('inference-migrations');f.docker('/usr/bin/docker',['stop','--time','1',completed]);expect(f.status()).toMatchObject({ready:true});
 }finally{f.close();}
});
it('verifies real selected image custody in an independent Node process and fails closed on malformed selection',()=>{
 const f=fixture();try{
  f.create();const module=resolve(import.meta.dirname,'../src/supervisor/development-component-container.ts');
  const script=`import {execFileSync} from 'node:child_process';import {managedComponentStatus} from ${JSON.stringify(module)};
   const command=(exe,args)=>execFileSync(exe,args,{encoding:'utf8',timeout:10000});
   console.log(JSON.stringify(managedComponentStatus(${JSON.stringify(f.input)},${JSON.stringify(f.project)},${JSON.stringify(f.override)},command)));`;
  const run=()=>execFileSync(process.execPath,['--import','tsx','--input-type=module','--eval',script],{cwd:resolve(import.meta.dirname,'..'),encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});
  expect(JSON.parse(run())).toMatchObject({ready:true});writeFileSync(f.override,'not json');expect(run).toThrow();
 }finally{f.close();}
});
it('rejects real Docker service identity drift and undeclared ownership while retaining unrelated services',()=>{
 const f=fixture();try{
  f.create();f.create('unexpected');expect(f.status).toThrow();
  const extra=f.ids.at(-1)!;f.docker('/usr/bin/docker',['rm','--force',extra]);f.ids.pop();
  const unrelated=f.docker('/usr/bin/docker',['run','--detach','--read-only','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges:true',
   '--label',`com.docker.compose.project=${f.project}`,'--label','com.docker.compose.service=unrelated',f.image,'node','-e','setInterval(()=>{},1000)']).trim();
  f.ids.push(unrelated);expect(f.status()).toMatchObject({ready:true});
 }finally{f.close();}
});
it('uses the same real Docker image authority during activation readiness and subsequent status',()=>{
 const f=fixture();try {
  f.create();const input={...f.input,action:'start' as const};
  expect(waitForManagedReadiness(f.docker,f.project,input,new Map([['treedx',f.image]]))).toMatchObject({ready:true});
  expect(()=>waitForManagedReadiness(f.docker,f.project,input,new Map([['treedx',`sha256:${'0'.repeat(64)}`]]))).toThrow();
  expect(f.status()).toMatchObject({ready:true});
 }finally{f.close();}
});

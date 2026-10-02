import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {expect,it} from 'vitest';
import {managedComponentStatus,renderManagedComponentOverride,waitForManagedReadiness} from '../src/supervisor/development-component-container.js';
import {resolveDevelopmentRuntimeImage} from '../src/supervisor/development-container.js';

function fixture() {
 const root=mkdtempSync(resolve(tmpdir(),'managed-image-status-')),project=`image-custody-${process.pid}-${root.split('-').at(-1)}`;
 const input={sessionId:`dev-native-${process.pid}`,projectId:'treedx' as const,targetId:'service' as const,action:'status' as const};
 const override=resolve(root,'compose.json'),ids:string[]=[];
 const docker=(_executable:string,args:readonly string[])=>execFileSync('/usr/bin/docker',[...args],{encoding:'utf8',timeout:180000,stdio:['ignore','pipe','pipe']});
 const image=resolveDevelopmentRuntimeImage(docker);
 const select=(images=new Map([['treedx',image]]))=>writeFileSync(override,JSON.stringify(renderManagedComponentOverride(input,images)),{mode:0o600});
 select();
 const create=(service='treedx',sessionId=input.sessionId)=>{
  const id=docker('/usr/bin/docker',['run','--detach','--read-only','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges:true',
   '--label',`com.docker.compose.project=${project}`,'--label',`com.docker.compose.service=${service}`,
   '--label',`org.treeseed.development.session=${sessionId}`,'--label','org.treeseed.development.target=treedx.service',
   image,'node','-e','setInterval(()=>{},1000)']).trim();ids.push(id);return id;
 };
 const status=()=>managedComponentStatus(input,project,override,docker);
 return {root,project,input,override,image,ids,docker,create,select,status,
  close(){try{for(const id of ids)docker('/usr/bin/docker',['rm','--force',id]);}finally{rmSync(root,{recursive:true,force:true});}}};
}

it('binds real Docker image identity to the native selected file and rejects digest drift',()=>{
 const f=fixture();try {
  f.create();expect(f.status()).toMatchObject({registered:true,ready:true});
  f.select(new Map([['treedx',`sha256:${'0'.repeat(64)}`]]));expect(f.status).toThrow();
 }finally{f.close();}
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

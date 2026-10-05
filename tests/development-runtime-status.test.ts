import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { copyDevelopmentRuntime, developmentRuntimeStatus, assertDevelopmentRuntimeMounts } from '../src/supervisor/development-runtime-copy.js';
import { resolveDevelopmentRuntimeImage } from '../src/supervisor/development-container.js';
const temporary:string[]=[];
const uid=process.getuid!();
afterEach(()=>{for(const root of temporary.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture() {
  const root=mkdtempSync(resolve(tmpdir(),'development-selected-runtime-'));temporary.push(root);
  const workspace=resolve(root,'workspace'),worktree=resolve(workspace,'source'),directory=resolve(root,'private');
  mkdirSync(directory);mkdirSync(resolve(worktree,'dist'),{recursive:true});
  mkdirSync(resolve(worktree,'node_modules'));mkdirSync(resolve(worktree,'drizzle'));
  writeFileSync(resolve(worktree,'package.json'),'{}');writeFileSync(resolve(worktree,'dist','main.js'),'export const value=1;');
  const dependency=resolve(workspace,'dependency');mkdirSync(dependency);writeFileSync(resolve(dependency,'index.js'),'export const linked=1;');
  symlinkSync(dependency,resolve(worktree,'node_modules','a'));symlinkSync(dependency,resolve(worktree,'node_modules','b'));
  const receipt=copyDevelopmentRuntime({workspace,worktree,destination:resolve(directory,'runtime'),sourceUid:uid});
  writeFileSync(resolve(directory,'runtime-receipt.json'),JSON.stringify(receipt),{mode:0o600});
  return {root,directory,worktree,receipt,runtime:resolve(directory,'runtime')};
}
it('reads the exact immutable copy and internal directory aliases without using mutable source',()=>{
  const f=fixture(),before=readFileSync(resolve(f.directory,'runtime-receipt.json'));
  writeFileSync(resolve(f.worktree,'dist/main.js'),'changed source');
  expect(developmentRuntimeStatus(f.directory,undefined,uid)).toEqual(f.receipt);
  expect(readFileSync(resolve(f.directory,'runtime-receipt.json'))).toEqual(before);
});
it.each(['bytes','deleted','added','hidden','mode','writable','alias','escaped','unreadable'] as const)(
  'rejects %s private-copy mutation instead of echoing the saved digest',shape=>{
    const f=fixture(),path=resolve(f.runtime,'dist/main.js');
    if(shape==='bytes')writeFileSync(path,'export const value=2;');
    if(shape==='deleted')rmSync(path);
    if(shape==='added'||shape==='hidden')writeFileSync(resolve(f.runtime,shape==='added'?'dist/extra.js':'dist/.extra.js'),'extra');
    if(shape==='mode')chmodSync(path,0o755);
    if(shape==='writable')chmodSync(path,0o666);
    if(shape==='unreadable')chmodSync(path,0);
    if(shape==='alias'||shape==='escaped'){
      const alias=resolve(f.runtime,'node_modules/b'),target=resolve(f.runtime,'node_modules/a/index.js'),before=readFileSync(target);
      expect(lstatSync(alias).isSymbolicLink()).toBe(true);
      // Node 24.12 rmSync reports EISDIR for a directory symlink; unlink only the alias.
      unlinkSync(alias);expect(readFileSync(target)).toEqual(before);
      symlinkSync(shape==='alias'?'../a':'/tmp',alias);
    }
    expect(()=>developmentRuntimeStatus(f.directory,undefined,uid)).toThrow();
  });
it('rejects missing malformed empty wrong-owner writable and symlink receipts',()=>{
  for(const shape of ['missing','malformed','empty','owner','writable','symlink','extra','count','digest','oversized']) {
    const f=fixture(),path=resolve(f.directory,'runtime-receipt.json');
    if(shape==='missing')rmSync(path);
    if(shape==='malformed')writeFileSync(path,'not json');
    if(shape==='empty')writeFileSync(path,JSON.stringify({files:0,bytes:0,digest:f.receipt.digest}));
    if(shape==='extra')writeFileSync(path,JSON.stringify({...f.receipt,unexpected:true}));
    if(shape==='count')writeFileSync(path,JSON.stringify({...f.receipt,files:f.receipt.files+1}));
    if(shape==='digest')writeFileSync(path,JSON.stringify({...f.receipt,digest:`sha256:${'0'.repeat(64)}`}));
    if(shape==='oversized')writeFileSync(path,' '.repeat(1025));
    if(shape==='writable')chmodSync(path,0o666);
    if(shape==='symlink'){rmSync(path);symlinkSync(resolve(f.worktree,'package.json'),path);}
    expect(()=>developmentRuntimeStatus(f.directory,undefined,shape==='owner'?uid+1:uid)).toThrow();
  }
});
it('rejects changed root inventory root symlinks cycles and special files with bounded native failure',()=>{
  for(const shape of ['extra-root','deleted-root','root-symlink','cycle','fifo']) {
    const f=fixture();
    if(shape==='extra-root')mkdirSync(resolve(f.runtime,'unexpected'));
    if(shape==='deleted-root')rmSync(resolve(f.runtime,'drizzle'),{recursive:true});
    if(shape==='root-symlink'){rmSync(f.runtime,{recursive:true});symlinkSync(f.worktree,f.runtime);}
    if(shape==='cycle')symlinkSync('.',resolve(f.runtime,'dist/cycle'));
    if(shape==='fifo')execFileSync('/usr/bin/mkfifo',[resolve(f.runtime,'dist/pipe')],{timeout:5000});
    const module=resolve(import.meta.dirname,'../src/supervisor/development-runtime-copy.ts');
    const script=`import {developmentRuntimeStatus} from ${JSON.stringify(module)};developmentRuntimeStatus(${JSON.stringify(f.directory)},undefined,${uid});`;
    expect(()=>execFileSync(process.execPath,['--import','tsx','--input-type=module','--eval',script],{
      cwd:resolve(import.meta.dirname,'..'),timeout:5000,stdio:'pipe'})).toThrow();
  }
});
it('reads and rejects changed copy bytes through a real independent Node process',()=>{
  const f=fixture(),module=resolve(import.meta.dirname,'../src/supervisor/development-runtime-copy.ts');
  const script=`import {developmentRuntimeStatus} from ${JSON.stringify(module)};console.log(JSON.stringify(developmentRuntimeStatus(${JSON.stringify(f.directory)},undefined,${uid})));`;
  const run=()=>execFileSync(process.execPath,['--import','tsx','--input-type=module','--eval',script],{cwd:resolve(import.meta.dirname,'..'),encoding:'utf8',stdio:['ignore','pipe','pipe']});
  expect(JSON.parse(run())).toEqual(f.receipt);
  writeFileSync(resolve(f.runtime,'dist/main.js'),'changed private runtime');
  expect(run).toThrow();
});
it('binds exact session target and read-only code mounts, including duplicate and overlay denial',()=>{
  const session='dev-example',directory='/run/treeseed/development-containers/dev-example/agent/provider';
  const names=['dist','package.json','node_modules'];
  const instance={labels:{'org.treeseed.development.session':session,'org.treeseed.development.target':'agent.provider'},
    mounts:names.map(name=>({Source:`${directory}/runtime/${name}`,Destination:`/app/${name}`,RW:false,Type:'bind'}))};
  expect(()=>assertDevelopmentRuntimeMounts(instance,session,'agent.provider',directory,names)).not.toThrow();
  for(const candidate of [
    {...instance,labels:{...instance.labels,'org.treeseed.development.session':'dev-other'}},
    {...instance,labels:{...instance.labels,'org.treeseed.development.target':'agent.sandbox'}},
    {...instance,mounts:instance.mounts.slice(1)},
    {...instance,mounts:instance.mounts.map((mount,index)=>index?mount:{...mount,RW:true})},
    {...instance,mounts:instance.mounts.map((mount,index)=>index?mount:{...mount,Source:'/wrong/source'})},
    {...instance,mounts:[...instance.mounts,instance.mounts[0]!]},
    {...instance,mounts:[...instance.mounts,{Source:'/wrong',Destination:'/app/dist/nested',RW:false,Type:'bind'}]},
    {...instance,mounts:[...instance.mounts,{Source:'/wrong',Destination:'/app',RW:false,Type:'bind'}]},
  ]) expect(()=>assertDevelopmentRuntimeMounts(candidate,session,'agent.provider',directory,names)).toThrow();
});
it('binds real Docker read-only mount inventory to the actual private copy and rejects subsequent byte changes',()=>{
  const f=fixture(),session=`dev-native-${process.pid}`,target='api.operations-runner';
  const docker=(_executable:string,args:readonly string[])=>execFileSync('/usr/bin/docker',[...args],{encoding:'utf8',timeout:180_000,stdio:['ignore','pipe','pipe']});
  const image=resolveDevelopmentRuntimeImage(docker);
  const id=docker('/usr/bin/docker',['run','--detach','--read-only','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges:true',
    '--label',`org.treeseed.development.session=${session}`,'--label',`org.treeseed.development.target=${target}`,
    '--mount',`type=bind,source=${f.runtime},target=/app,readonly`,image,'node','-e','setInterval(()=>{},1000)']).trim();
  expect(id).toMatch(/^[a-f0-9]{64}$/u);
  try {
    const inspected=JSON.parse(docker('/usr/bin/docker',['inspect',id,'--format','{"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}}}']));
    assertDevelopmentRuntimeMounts(inspected,session,target,f.directory,['.']);
    expect(developmentRuntimeStatus(f.directory,undefined,uid)).toEqual(f.receipt);
    expect(()=>assertDevelopmentRuntimeMounts(inspected,'dev-other',target,f.directory,['.'])).toThrow();
    writeFileSync(resolve(f.runtime,'dist/main.js'),'changed private code');
    expect(()=>developmentRuntimeStatus(f.directory,undefined,uid)).toThrow();
  } finally {docker('/usr/bin/docker',['rm','--force',id]);}
},240_000);

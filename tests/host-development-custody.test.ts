import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import * as host from '../src/supervisor/host-development.js';
import { hostDevelopmentRuntimeStatus } from '../src/supervisor/host-development-custody.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive:true, force:true}); });
const digest = (value: string | Buffer) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const selected = hostDevelopmentRuntimeStatus;
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(),'host-selected-custody-')); roots.push(root);
  const id = 'dev-1788100000000-deadbeef', generation = resolve(root,'generations',id);
  const paths = ['package.json','dist/src/bin/api.js','dist/src/bin/supervisor.js','node_modules/zod/index.js'].sort((a,b)=>a.localeCompare(b));
  const files = paths.map(path => {
    mkdirSync(resolve(generation,path,'..'),{recursive:true});
    const bytes = path === 'package.json' ? '{"type":"module"}' : `export const selected = ${JSON.stringify(path)};`;
    writeFileSync(resolve(generation,path),bytes);
    return {path,size:Buffer.byteLength(bytes),sha256:digest(bytes)};
  });
  const state = {schemaVersion:'treeseed.host-development-generation/v1',generationId:id,status:'active',worktree:'/historical/deployment',
    manifestDigest:digest(JSON.stringify(files)),guestImageDigest:null,message:null,updatedAt:'2026-10-02T00:00:00.000Z'};
  writeFileSync(resolve(root,'state.json'),JSON.stringify(state));
  return {root,generation,files,state};
}

it('reads exact selected runtime hashes rather than historical workspace bytes without mutating state', () => {
  const {root,files}=fixture(), before=readFileSync(resolve(root,'state.json'));
  expect(selected(root)).toMatchObject({status:'active',files});
  expect(readFileSync(resolve(root,'state.json'))).toEqual(before);
});
it('rejects modified deleted and additional selected runtime files', () => {
  for (const shape of ['modified','deleted','additional']) {
    const {root,generation}=fixture(), file=resolve(generation,'dist/src/bin/api.js');
    if(shape==='modified')writeFileSync(file,'changed runtime');
    else if(shape==='deleted')rmSync(file);
    else writeFileSync(resolve(generation,'dist/src/bin/extra.js'),'additional runtime');
    expect(()=>selected(root)).toThrow();
  }
});
it('rejects file directory and generation symlink escapes', () => {
  for (const shape of ['file','directory','generation']) {
    const {root,generation}=fixture(), target=shape==='file'?resolve(generation,'dist/src/bin/api.js'):shape==='directory'?resolve(generation,'dist'):generation;
    rmSync(target,{recursive:true}); symlinkSync('/tmp',target);
    expect(()=>selected(root)).toThrow();
  }
});
it('rejects invalid selected generation ids and missing generation directories', () => {
  for(const id of ['../../outside','installed','dev-1788100000000-deadbeef']) {
    const {root,state,generation}=fixture(); rmSync(generation,{recursive:true});
    writeFileSync(resolve(root,'state.json'),JSON.stringify({...state,generationId:id}));
    expect(()=>selected(root)).toThrow();
  }
});
it('does not claim selected runtime proof for installed or transitional states', () => {
  for(const status of ['activating','deactivating','installed','rolled-back']) {
    const {root,state}=fixture();writeFileSync(resolve(root,'state.json'),JSON.stringify({...state,status}));
    expect(selected(root)).toMatchObject({status,files:null});
  }
});
it('rejects unsupported generation nodes instead of reporting a passing inventory', () => {
  const {root,generation}=fixture();mkdirSync(resolve(generation,'unexpected'));
  expect(()=>selected(root)).toThrow();
});
it('rejects a missing package or empty selected inventory even when a saved digest matches', () => {
  for(const files of [[],[{path:'dist/only.js',size:1,sha256:digest('x')}]]) {
    const {root,generation,state}=fixture();rmSync(generation,{recursive:true});mkdirSync(generation);
    for(const file of files){mkdirSync(resolve(generation,file.path,'..'),{recursive:true});writeFileSync(resolve(generation,file.path),'x');}
    writeFileSync(resolve(root,'state.json'),JSON.stringify({...state,manifestDigest:digest(JSON.stringify(files))}));
    expect(()=>selected(root)).toThrow();
  }
});
it('rejects unreadable selected files instead of substituting a missing sentinel', () => {
  const {root,generation}=fixture(), path=resolve(generation,'package.json');
  chmodSync(path,0);
  try {expect(()=>selected(root)).toThrow();} finally {chmodSync(path,0o600);}
});
it('reads exact selected filesystem custody through a real isolated child process', () => {
  const {root,files}=fixture();
  const module=resolve(import.meta.dirname,'../src/supervisor/host-development-custody.ts');
  const program=`import {hostDevelopmentRuntimeStatus} from ${JSON.stringify(module)};console.log(JSON.stringify(hostDevelopmentRuntimeStatus(${JSON.stringify(root)})));`;
  const result=JSON.parse(execFileSync(process.execPath,['--import','tsx','--input-type=module','--eval',program],{encoding:'utf8',cwd:resolve(import.meta.dirname,'..')}));
  expect(result.files).toEqual(files);
});
it('routes the existing fixed status operation to selected custody without adding caller-selected paths', () => {
  const source=readFileSync(resolve(import.meta.dirname,'../src/supervisor/execute.ts'),'utf8');
  expect(source).toContain("case 'host.development.status': return hostDevelopmentRuntimeStatus();");
  expect(host.hostDevelopmentActivationSchema.safeParse({generationId:'dev-1788100000000-deadbeef',worktree:'/tmp/deployment',packageSha256:digest('package'),
    files:Array.from({length:3},()=>({path:'package.json',size:1,sha256:digest('same')}))}).success).toBe(false);
});

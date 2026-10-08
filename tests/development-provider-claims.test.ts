import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { activeAgentClaims } from '../src/supervisor/development-agent-container.js';
const temporary:string[]=[];
afterEach(()=>{for(const root of temporary.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(value?:unknown) {
  const root=mkdtempSync(resolve(tmpdir(),'provider-claims-'));temporary.push(root);
  if(value!==undefined) { mkdirSync(resolve(root,'runtime'));writeFileSync(resolve(root,'runtime/capacity-state.json'),JSON.stringify(value)); }
  return root;
}
it('keeps arbitrary configured identities active for ready running and recovery claims',()=>{
  const claims=['ready','running','recovery'].map(status=>({id:`renamed-${status}`,status}));
  expect(activeAgentClaims(fixture({schemaVersion:1,claims}))).toEqual(claims);
});
it('allows only empty missing and polling state without active claims',()=>{
  expect(activeAgentClaims(fixture())).toEqual([]);
  for(const claims of [[],[{id:'renamed-poller',status:'polling'}]]) expect(activeAgentClaims(fixture({schemaVersion:1,claims}))).toEqual([]);
});
it('fails closed on invalid claim inventory and named fields without ignoring earlier active claims',()=>{
  for(const value of [null,{},[],{schemaVersion:2,claims:[]},{schemaVersion:1,claims:null},
    ...[null,{},[],{id:'x'},{status:'running'},{id:12,status:'running'},{id:'x',status:'unknown'}].map(claim=>({schemaVersion:1,claims:[{id:'valid',status:'running'},claim]}))])
    expect(()=>activeAgentClaims(fixture(value))).toThrow();
});
it('retains unresolved operator custody as inactive without hiding ready running or recovery claims',()=>{
  const held={id:'renamed-unresolved',status:'unresolved',requestedSeconds:12,
    dispatchEnvelope:{original:'held'},closeoutOutput:{failed:'held'},failureMessage:'original failure'};
  for(const statuses of [[],['ready'],['running'],['recovery'],['ready','running','recovery']]) {
    const active=statuses.map(status=>({id:`renamed-${status}`,status}));
    const root=fixture({schemaVersion:1,claims:[held,...active]}),path=resolve(root,'runtime/capacity-state.json');
    const bytes=readFileSync(path);expect(activeAgentClaims(root)).toEqual(active);
    expect(readFileSync(path)).toEqual(bytes);expect(activeAgentClaims(root)).toEqual(active);
    expect(readFileSync(path)).toEqual(bytes);
  }
});
it('native independent claim reader preserves unresolved bytes and exact active inventory without repair',()=>{
  const root=fixture({schemaVersion:1,claims:[]}),path=resolve(root,'runtime/capacity-state.json');
  const reader=resolve(root,'reader.ts');
  writeFileSync(reader,`import {activeAgentClaims} from ${JSON.stringify(pathToFileURL(resolve('src/supervisor/development-agent-container.ts')).href)};
process.stdout.write(JSON.stringify(activeAgentClaims(process.argv[2])));`);
  const unresolved={id:'native-unresolved',status:'unresolved',requestedSeconds:12,
    dispatchEnvelope:{original:'held'},closeoutOutput:{failed:'held'},failureMessage:'original failure'};
  for(const statuses of [[],['ready','running','recovery']]) {
    const active=statuses.map(status=>({id:`native-${status}`,status}));
    writeFileSync(path,JSON.stringify({schemaVersion:1,claims:[unresolved,{id:'poll',status:'polling'},...active]}));
    const bytes=readFileSync(path);
    const actual=spawnSync(process.execPath,['--import','tsx',reader,root],{encoding:'utf8',timeout:4_000});
    expect(actual.error).toBeUndefined();expect(actual.signal).toBeNull();expect(actual.stderr).toBe('');
    expect(actual.status).toBe(0);expect(JSON.parse(actual.stdout)).toEqual(active);
    expect(readFileSync(path)).toEqual(bytes);
  }
  writeFileSync(path,JSON.stringify({schemaVersion:1,claims:[unresolved,{id:'bad',status:'unknown'}]}));
  const bytes=readFileSync(path),denied=spawnSync(process.execPath,['--import','tsx',reader,root],{encoding:'utf8',timeout:4_000});
  expect(denied.error).toBeUndefined();expect(denied.signal).toBeNull();expect(denied.status).toBe(1);
  expect(denied.stdout).toBe('');expect(denied.stderr).toContain('Provider-local capacity claim is invalid');
  expect(readFileSync(path)).toEqual(bytes);
});

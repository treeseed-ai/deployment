import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
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

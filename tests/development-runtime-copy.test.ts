import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyDevelopmentRuntime } from '../src/supervisor/development-runtime-copy.js';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'runner-copy-'));roots.push(root);
  const workspace=join(root,'workspace'),worktree=join(workspace,'api');
  mkdirSync(worktree,{recursive:true});
  for(const name of ['dist','node_modules','drizzle'])mkdirSync(join(worktree,name));
  writeFileSync(join(worktree,'package.json'),'{}');
  writeFileSync(join(worktree,'dist','entry.js'),'export {};');
  writeFileSync(join(worktree,'.env'),'excluded-secret');
  return {root,workspace,worktree,destination:join(root,'candidate'),sourceUid:process.getuid!()};
}
it('materializes private dependency symlinks into self-contained code with a digest',()=>{
  const f=fixture(),snapshot=join(f.workspace,'snapshot');mkdirSync(snapshot,{mode:0o700});
  writeFileSync(join(snapshot,'index.js'),'export const value=1;');
  symlinkSync(snapshot,join(f.worktree,'node_modules','library'));
  const receipt=copyDevelopmentRuntime(f);
  expect(receipt.files).toBe(3);expect(receipt.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(readFileSync(join(f.destination,'node_modules','library','index.js'),'utf8')).toContain('value=1');
  expect(()=>readFileSync(join(f.destination,'.env'))).toThrow();
  expect(()=>copyDevelopmentRuntime(f)).toThrow();
});
it('rejects external symlinks before copying their contents',()=>{
  const f=fixture();writeFileSync(join(f.root,'private'),'secret');
  symlinkSync(join(f.root,'private'),join(f.worktree,'node_modules','escape'));
  expect(()=>copyDevelopmentRuntime(f)).toThrow('escaped');
});
it('excludes VCS and hidden custody from linked workspace dependencies',()=>{
  const f=fixture(),dependency=join(f.workspace,'dependency');mkdirSync(dependency);
  writeFileSync(join(dependency,'index.js'),'export {};');
  for(const name of ['.git','.treeseed','.cache']) {
    mkdirSync(join(dependency,name));writeFileSync(join(dependency,name,'private'),'never-copy');
  }
  writeFileSync(join(dependency,'.env'),'never-copy');
  symlinkSync(dependency,join(f.worktree,'node_modules','dependency'));
  copyDevelopmentRuntime(f);
  expect(readFileSync(join(f.destination,'node_modules','dependency','index.js'),'utf8')).toBe('export {};');
  for(const name of ['.git','.treeseed','.cache','.env'])expect(()=>statSync(join(f.destination,'node_modules','dependency',name))).toThrow();
});
it('rejects source identity mismatches and directory cycles',()=>{
  const f=fixture();expect(()=>copyDevelopmentRuntime({...f,sourceUid:f.sourceUid+1})).toThrow('escaped');
  symlinkSync(f.worktree,join(f.worktree,'node_modules','cycle'));
  expect(()=>copyDevelopmentRuntime({...f,destination:join(f.root,'other')})).toThrow('cycle');
});
it('rejects a destination within the source workspace',()=>{
  const f=fixture();expect(()=>copyDevelopmentRuntime({...f,destination:join(f.worktree,'copy')})).toThrow('outside');
});
it('copies npm hardlinks into independent private files',()=>{
  const f=fixture(),original=join(f.worktree,'dist','entry.js');
  linkSync(original,join(f.worktree,'node_modules','linked.js'));
  copyDevelopmentRuntime(f);writeFileSync(original,'changed');
  const copied=join(f.destination,'node_modules','linked.js');
  expect(readFileSync(copied,'utf8')).toBe('export {};');expect(statSync(copied).ino).not.toBe(statSync(original).ino);
});

import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import * as runtime from '../src/index.js';
import { copyDevelopmentRuntime } from '../src/supervisor/development-runtime-copy.js';

it('exposes the identical runtime materialization authority through the package root', () => {
 expect(Reflect.get(runtime, 'copyDevelopmentRuntime')).toBe(copyDevelopmentRuntime);
});

function fixture() {
 const root=mkdtempSync(resolve(tmpdir(),'public-runtime-copy-')),workspace=resolve(root,'workspace'),worktree=resolve(workspace,'source');
 mkdirSync(resolve(worktree,'dist'),{recursive:true});mkdirSync(resolve(worktree,'node_modules'));mkdirSync(resolve(worktree,'drizzle'));
 writeFileSync(resolve(worktree,'package.json'),'{}');writeFileSync(resolve(worktree,'dist/entry.js'),'export const value=1;');
 return {root,workspace,worktree,destination:resolve(root,'candidate'),sourceUid:process.getuid!()};
}
function run(input:Parameters<typeof copyDevelopmentRuntime>[0]) {
 const output=execFileSync(process.execPath,['--import','tsx',resolve(import.meta.dirname,'support/public-runtime-copy-worker.ts'),JSON.stringify(input)],
  {cwd:resolve(import.meta.dirname,'..'),encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']});
 return JSON.parse(output) as ReturnType<typeof copyDevelopmentRuntime>;
}

it('materializes exact independent private bytes through the public package root in a native process', () => {
 const f=fixture();
 try {
  const expected=copyDevelopmentRuntime({...f,destination:resolve(f.root,'independent')});
  expect(run(f)).toEqual(expected);
  const source=resolve(f.worktree,'dist/entry.js'),privateFile=resolve(f.destination,'dist/entry.js');
  expect(statSync(privateFile).ino).not.toBe(statSync(source).ino);
  writeFileSync(source,'changed source');expect(readFileSync(privateFile,'utf8')).toBe('export const value=1;');
 } finally {rmSync(f.root,{recursive:true,force:true});}
});

it('retains workspace alias hidden-file filtering bin and normalized modes through the native public API', () => {
 const f=fixture();
 try {
  const dependency=resolve(f.workspace,'dependency');mkdirSync(dependency);writeFileSync(resolve(dependency,'index.js'),'dependency');
  writeFileSync(resolve(dependency,'.env'),'must not copy');chmodSync(resolve(dependency,'index.js'),0o641);
  symlinkSync(dependency,resolve(f.worktree,'node_modules/a'));symlinkSync(dependency,resolve(f.worktree,'node_modules/b'));
  mkdirSync(resolve(f.worktree,'node_modules/.bin'));writeFileSync(resolve(f.worktree,'node_modules/.bin/tool'),'tool');
  const expected=copyDevelopmentRuntime({...f,destination:resolve(f.root,'independent')});expect(run(f)).toEqual(expected);
  expect(readFileSync(resolve(f.destination,'node_modules/b/index.js'),'utf8')).toBe('dependency');
  expect(statSync(resolve(f.destination,'node_modules/a/index.js')).mode&0o777).toBe(0o755);
  expect(existsSync(resolve(f.destination,'node_modules/a/.env'))).toBe(false);
  expect(readFileSync(resolve(f.destination,'node_modules/.bin/tool'),'utf8')).toBe('tool');
 } finally {rmSync(f.root,{recursive:true,force:true});}
});

it('fails closed on escaped dependencies and source destinations through the native public API without deleting source', () => {
 const f=fixture();
 try {
  expect(run({...f,destination:resolve(f.root,'valid')})).toEqual(copyDevelopmentRuntime({...f,destination:resolve(f.root,'independent')}));
  const outside=resolve(f.root,'private');writeFileSync(outside,'unchanged private source');
  symlinkSync(outside,resolve(f.worktree,'node_modules/escape'));
  expect(()=>run(f)).toThrow('escaped operator-owned workspace custody');
  expect(existsSync(f.destination)).toBe(false);expect(readFileSync(outside,'utf8')).toBe('unchanged private source');
  expect(()=>run({...f,destination:resolve(f.worktree,'candidate')})).toThrow('outside the source workspace');
  expect(readFileSync(resolve(f.worktree,'dist/entry.js'),'utf8')).toBe('export const value=1;');
 } finally {rmSync(f.root,{recursive:true,force:true});}
});

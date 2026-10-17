import {createHash} from 'node:crypto';
import {hostDevelopmentRuntimeStatus} from '../src/supervisor/host-development-custody.js';
import { expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyDevelopmentRuntime, developmentRuntimeStatus } from '@treeseed/deployment';
import { verifySelectedProviderCandidate } from './acceptance/selected-provider-candidate.js';

it('retains one exact selected held and frozen Agent candidate without changing original runtime observations', () => {
  const head = 'a'.repeat(40), runtime = { session: { sessionId: 'dev-controlled', status: 'active' }, candidates: ['original'] };
  const frozen = { sourceHeads: { agent: head }, runtimeTargets: runtime }, before = structuredClone({ frozen, runtime });
  verifySelectedProviderCandidate(head, head, frozen, runtime);
  expect({ frozen, runtime }).toEqual(before);
  const host={generationId:'dev-1788100000000-deadbeef',status:'active',manifestDigest:'sha256:'+'c'.repeat(64),guestImageDigest:'sha256:'+'d'.repeat(64),files:[{path:'package.json',size:2,sha256:'sha256:'+'e'.repeat(64)}]},captured={...frozen,host,guest:{digest:host.guestImageDigest}},held=structuredClone({captured,host});
  Reflect.apply(verifySelectedProviderCandidate,undefined,[head,head,captured,runtime,host]);
  for(const observed of [undefined,null,{}, {...host,status:'installed'}, {...host,generationId:'dev-1788100000000-feedbeef'},{...host,manifestDigest:'sha256:'+'f'.repeat(64)},{...host,guestImageDigest:'sha256:'+'f'.repeat(64)},{...host,files:[]},{...host,files:[{...host.files[0],sha256:'sha256:'+'f'.repeat(64)}]}]){
    expect(()=>Reflect.apply(verifySelectedProviderCandidate,undefined,[head,head,captured,runtime,observed])).toThrow('SOURCE_BUILD_HELD_CANDIDATE');expect({captured,host}).toEqual(held);
  }
});

it('denies absent malformed moved contradictory or substituted selected candidate authority without repairing failed inputs', () => {
  const head = 'a'.repeat(40), runtime = { session: { sessionId: 'dev-controlled', status: 'active' }, candidates: ['original'] };
  const frozen = { sourceHeads: { agent: head }, runtimeTargets: runtime };
  const denied: Array<Parameters<typeof verifySelectedProviderCandidate>> = [
    ['', head, frozen, runtime], ['staging', head, frozen, runtime], [head, '', frozen, runtime], [head.toUpperCase(), head, frozen, runtime],
    ['b'.repeat(40), head, frozen, runtime], [head, 'b'.repeat(40), frozen, runtime],
    ...[undefined, null, [], '', {}, { sourceHeads: null }, { sourceHeads: [] },
      { sourceHeads: { agent: 'staging' }, runtimeTargets: runtime },
      { sourceHeads: { agent: 'b'.repeat(40) }, runtimeTargets: runtime },
      { sourceHeads: { agent: head } }, { sourceHeads: { agent: head }, runtimeTargets: {} }]
      .map(value => [head, head, value, runtime] as Parameters<typeof verifySelectedProviderCandidate>),
    [head, head, frozen, null], [head, head, frozen, []],
    [head, head, frozen, { ...runtime, candidates: ['substituted'] }],
    [head, head, frozen, { ...runtime, session: { ...runtime.session, status: 'stopped' } }],
  ];
  for (const input of denied) {
    const before = structuredClone(input);
    expect(() => verifySelectedProviderCandidate(...input)).toThrow('SOURCE_BUILD_HELD_CANDIDATE');
    expect(input).toEqual(before);
  }
  expect(denied).toHaveLength(21); verifySelectedProviderCandidate(head, head, frozen, runtime);
});

it('native Git and public immutable materialization deny a moved held candidate despite a valid unchanged selected copy and retain exact concurrent retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'selected-provider-candidate-')), workspace = join(root, 'workspace'), worktree = join(workspace, 'source'), directory = join(root, 'private');
  mkdirSync(join(worktree, 'dist'), { recursive: true }); mkdirSync(join(worktree, 'node_modules')); mkdirSync(join(worktree, 'drizzle')); mkdirSync(directory);
  const git = (args: string[]) => execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', timeout: 5000 }).trim();
  try {
    writeFileSync(join(worktree, 'package.json'), '{}'); writeFileSync(join(worktree, 'dist/entry.js'), 'export const value = 1;');
    git(['init']); git(['config', 'user.name', 'Controlled selected source']); git(['config', 'user.email', 'selected-source@example.invalid']);
    git(['add', '.']); git(['commit', '-m', 'Original controlled source']); const head = git(['rev-parse', 'HEAD']);
    const receipt = copyDevelopmentRuntime({ workspace, worktree, destination: join(directory, 'runtime'), sourceUid: process.getuid!() });
    writeFileSync(join(directory, 'runtime-receipt.json'), JSON.stringify(receipt), { mode: 0o600 });
    const runtime = { session: { sessionId: 'dev-controlled', status: 'active' }, receipt }, frozen = { sourceHeads: { agent: head }, runtimeTargets: runtime };
    const before = structuredClone({ frozen, runtime, receipt }), bytes = readFileSync(join(directory, 'runtime/dist/entry.js'));
    const hostRoot=join(root,'host'),generationId='dev-1788100000000-deadbeef',generation=join(hostRoot,'generations',generationId),hash=(value:string)=>'sha256:'+createHash('sha256').update(value).digest('hex');
    const files=['package.json','dist/src/bin/api.js','dist/src/bin/supervisor.js','node_modules/zod/index.js'].sort((a,b)=>a.localeCompare(b)).map(path=>{const bytes=path==='package.json'?'{"type":"module"}':'export const selected = 1;';mkdirSync(join(generation,path,'..'),{recursive:true});writeFileSync(join(generation,path),bytes);return{path,size:Buffer.byteLength(bytes),sha256:hash(bytes)};});
    const state={schemaVersion:'treeseed.host-development-generation/v1',generationId,status:'active',worktree,manifestDigest:hash(JSON.stringify(files)),guestImageDigest:'sha256:'+'d'.repeat(64),message:null,updatedAt:'2026-10-17T00:00:00.000Z'},statePath=join(hostRoot,'state.json');writeFileSync(statePath,JSON.stringify(state));
    const host=hostDevelopmentRuntimeStatus(hostRoot),captured={...frozen,host,guest:{digest:state.guestImageDigest}},originalState=readFileSync(statePath),capturedBefore=structuredClone(captured);
    Reflect.apply(verifySelectedProviderCandidate,undefined,[head,head,captured,runtime,host]);
    writeFileSync(statePath,JSON.stringify({...state,guestImageDigest:'sha256:'+'f'.repeat(64)}));const movedHost=hostDevelopmentRuntimeStatus(hostRoot),failedState=readFileSync(statePath);
    expect(()=>Reflect.apply(verifySelectedProviderCandidate,undefined,[head,head,captured,runtime,movedHost])).toThrow('SOURCE_BUILD_HELD_CANDIDATE');expect(readFileSync(statePath)).toEqual(failedState);expect(captured).toEqual(capturedBefore);writeFileSync(statePath,originalState);
    for(const observed of await Promise.all(Array.from({length:4},async()=>hostDevelopmentRuntimeStatus(hostRoot))))Reflect.apply(verifySelectedProviderCandidate,undefined,[head,head,captured,runtime,observed]);expect(readFileSync(statePath)).toEqual(originalState);expect(captured).toEqual(capturedBefore);
    expect(developmentRuntimeStatus(directory, undefined, process.getuid!())).toEqual(receipt);
    verifySelectedProviderCandidate(head, git(['rev-parse', 'HEAD']), frozen, runtime);
    writeFileSync(join(worktree, 'dist/entry.js'), 'export const value = 2;'); git(['add', '.']); git(['commit', '-m', 'Different held source']);
    const moved = git(['rev-parse', 'HEAD']), failed = { sourceHeads: { agent: moved }, runtimeTargets: runtime }, failedBefore = structuredClone(failed);
    expect(developmentRuntimeStatus(directory, undefined, process.getuid!())).toEqual(receipt);
    expect(() => verifySelectedProviderCandidate(head, moved, failed, runtime)).toThrow('SOURCE_BUILD_HELD_CANDIDATE');
    expect(failed).toEqual(failedBefore); expect(readFileSync(join(directory, 'runtime/dist/entry.js'))).toEqual(bytes);
    git(['switch', '--detach', head]);
    const native = promisify(execFile);
    await Promise.all(Array.from({ length: 8 }, async () => {
      const observed = await native('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 });
      verifySelectedProviderCandidate(head, observed.stdout.trim(), frozen, runtime);
      expect(developmentRuntimeStatus(directory, undefined, process.getuid!())).toEqual(receipt);
    }));
    expect({ frozen, runtime, receipt }).toEqual(before); expect(failed).toEqual(failedBefore); expect(git(['status', '--porcelain'])).toBe('');
  } finally { rmSync(root, { recursive: true, force: true }); }
  expect(existsSync(root)).toBe(false);
}, 30_000);

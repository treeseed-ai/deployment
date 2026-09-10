import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { beginDevelopmentBackup, finishDevelopmentBackup, planDevelopmentBackup, markDevelopmentBackupRestored, fenceDevelopmentBackup, developmentBackupStatus, type DevelopmentBackupDependencies } from '../src/supervisor/development-backup.js';
import { assertDevelopmentNotHeld } from '../src/core/development-backup-hold.js';
import { supervisorOperationSchema } from '../src/supervisor/protocol.js';
import { component } from './fixtures.js';
import type { ManagedDevelopmentSession } from '../src/manager/development-sessions.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'treeseed-hold-')); roots.push(root);
  const api = component('api', 'development', 'a'), id = 'dev-test', image = `sha256:${'b'.repeat(64)}`, calls: string[] = [];
  const record = { session: { sessionId: id, status: 'active', targets: [{ projectId: 'api', targetId: 'operations-runner', mode: 'candidate' }] } } as ManagedDevelopmentSession;
  const dir = join(root, id, 'operations-runner'); mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'compose.json'), JSON.stringify({ services: { runtime: { image, container_name: `treeseed-${id}-api-operations-runner` } } }), { mode: 0o600 });
  writeFileSync(join(dir, 'runtime-receipt.json'), '{"digest":"original-snapshot"}', { mode: 0o600 });
  const state = { Id: 'a'.repeat(64), Name: `/treeseed-${id}-api-operations-runner`, Image: image,
    Config: { Labels: { 'org.treeseed.development.session': id, 'org.treeseed.development.target': 'api.operations-runner' } as Record<string, string> },
    State: { Running: true }, Mounts: [{ Source: '/var/lib/treeseed/components/api/published-knowledge', RW: true }] };
  let failure = '';
  const deps: DevelopmentBackupDependencies = { records: () => [record], components: () => [api], ownerUid: process.getuid!(),
    holdPath: join(root, 'hold.json'), runtimeRoot: root, members: () => ['var/lib/treeseed/components/api/published-knowledge'],
    command: (_command, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'ps') return args.includes('--quiet') ? state.Id : args.some(arg => arg.includes('treeseed-api-operations-runner-1')) ? '' : state.Name.slice(1);
      if (args[0] === 'inspect') return JSON.stringify(state);
      if (args[0] === 'wait') return failure === 'drain' ? '1' : '0';
      if (args[0] === 'kill') { state.State.Running = false; return ''; }
      if (args.includes('up')) { if (failure === 'resume') throw new Error('private backend text'); state.State.Running = true; }
      if (args.includes('down')) state.State.Running = false;
      return '';
    } };
  return { deps, api, state, record, calls, dir, fail: (value: string) => { failure = value; } };
}
describe('registered candidate backup hold', () => {
  it('drains without restoring released runner or deleting snapshots; resumes exact selection once', () => {
    const f = fixture(), original = JSON.stringify(f.record);
    expect(beginDevelopmentBackup(1, f.deps, f.api.runtimeDigest)).toEqual({ held: true, generation: 1, targets: 1 });
    expect(f.state.State.Running).toBe(false);
    expect(() => assertDevelopmentNotHeld(f.deps.holdPath)).toThrow('held');
    expect(f.calls.some(call => call.startsWith('start '))).toBe(false);
    expect(existsSync(join(f.dir, 'runtime-receipt.json'))).toBe(true);
    expect(finishDevelopmentBackup(1, f.deps)).toEqual({ resumed: true, generation: 1, targets: 1 });
    expect(f.state.State.Running).toBe(true); expect(existsSync(f.deps.holdPath)).toBe(false);
    expect(JSON.stringify(f.record)).toBe(original);
    expect(f.calls.filter(call => call.includes(' up '))).toHaveLength(1);
  });
  it('refuses an incompatible API change before stopping any writer', () => {
    const f = fixture();
    expect(() => beginDevelopmentBackup(1, f.deps, 'c'.repeat(64))).toThrow('compatible');
    expect(f.state.State.Running).toBe(true); expect(existsSync(f.deps.holdPath)).toBe(false);
  });
  it('rejects unknown writers and label-only impersonation before outage', () => {
    for (const mutate of [(f: ReturnType<typeof fixture>) => { f.state.Config.Labels = {}; },
      (f: ReturnType<typeof fixture>) => { f.state.Name = '/other'; },
      (f: ReturnType<typeof fixture>) => { f.state.Image = `sha256:${'c'.repeat(64)}`; },
      (f: ReturnType<typeof fixture>) => { f.record.session.targets[0]!.mode = 'released'; }]) {
      const f = fixture(); mutate(f);
      expect(() => beginDevelopmentBackup(1, f.deps, f.api.runtimeDigest)).toThrow();
      expect(f.calls.some(call => call.startsWith('kill '))).toBe(false);
      expect(existsSync(f.deps.holdPath)).toBe(false);
    }
  });
  it('rejects changed snapshots, selections and API runtime before resumption', () => {
    for (const mutate of [(f: ReturnType<typeof fixture>) => { writeFileSync(join(f.dir, 'runtime-receipt.json'), 'changed'); },
      (f: ReturnType<typeof fixture>) => { f.record.session.targets[0]!.mode = 'released'; },
      (f: ReturnType<typeof fixture>) => { f.api.runtimeDigest = 'c'.repeat(64); }]) {
      const f = fixture(); beginDevelopmentBackup(1, f.deps, f.api.runtimeDigest); mutate(f);
      expect(() => finishDevelopmentBackup(1, f.deps)).toThrow();
      expect(f.calls.some(call => call.includes(' up '))).toBe(false);
      expect(existsSync(f.deps.holdPath)).toBe(true);
    }
  });
  it('retains the interlock after restart, rejects overlapping generations and wrong finish', () => {
    const f = fixture(); beginDevelopmentBackup(1, f.deps, f.api.runtimeDigest);
    expect(() => beginDevelopmentBackup(2, { ...f.deps }, f.api.runtimeDigest)).toThrow('interrupted');
    expect(() => finishDevelopmentBackup(2, { ...f.deps })).toThrow('Exact');
    expect(f.state.State.Running).toBe(false);
  });
  it('contains failed resumption and does not expose backend diagnostics', () => {
    const f = fixture(); beginDevelopmentBackup(1, f.deps, f.api.runtimeDigest); f.fail('resume');
    expect(() => finishDevelopmentBackup(1, f.deps)).toThrow('retained and fenced');
    expect(JSON.parse(readFileSync(f.deps.holdPath, 'utf8')).phase).toBe('recovery-required');
    expect(() => finishDevelopmentBackup(1, f.deps)).toThrow('interrupted');
    expect(f.state.State.Running).toBe(false);
  });
  it('restores candidate on preparation/drain failure before any released shutdown', () => {
    const f = fixture(); f.fail('drain');
    expect(() => beginDevelopmentBackup(1, f.deps, f.api.runtimeDigest)).toThrow('preparation failed');
    expect(f.state.State.Running).toBe(true); expect(existsSync(f.deps.holdPath)).toBe(false);
  });
  it('rejects writable or symlinked root snapshots', () => {
    const f = fixture(); chmodSync(join(f.dir, 'compose.json'), 0o666);
    expect(() => planDevelopmentBackup(f.deps, f.api.runtimeDigest)).toThrow('custody');
    rmSync(join(f.dir, 'compose.json')); symlinkSync(join(f.dir, 'runtime-receipt.json'), join(f.dir, 'compose.json'));
    expect(() => planDevelopmentBackup(f.deps, f.api.runtimeDigest)).toThrow('custody');
  });
  it('holds even without existing candidate writers so a new one cannot race capture', () => {
    const f = fixture(); f.state.Mounts[0]!.RW = false;
    expect(beginDevelopmentBackup(1, f.deps, f.api.runtimeDigest).targets).toBe(0);
    expect(() => assertDevelopmentNotHeld(f.deps.holdPath)).toThrow();
    finishDevelopmentBackup(1, f.deps); expect(existsSync(f.deps.holdPath)).toBe(false);
  });
  it('accepts only fixed generation operations without caller paths or commands', () => {
    for (const operation of ['development.backup.begin', 'development.backup.finish']) {
      expect(() => supervisorOperationSchema.parse({ operation, generation: 1 })).not.toThrow();
      for (const extra of [{ command: 'sh' }, { holdPath: '/tmp/owned' }, { generation: -1 }])
        expect(() => supervisorOperationSchema.parse({ operation, generation: 1, ...extra })).toThrow();
    }
  });
  it('requires an authenticated coordinated restore before recovering an interrupted resume', () => {
    const f = fixture(); beginDevelopmentBackup(1, f.deps, f.api.runtimeDigest); f.fail('resume');
    expect(() => finishDevelopmentBackup(1, f.deps)).toThrow(); f.fail('');
    expect(developmentBackupStatus(f.deps)).toEqual({ generation: 1, phase: 'recovery-required', targets: 1 });
    fenceDevelopmentBackup(1, f.deps, f.api.runtimeDigest);
    expect(() => finishDevelopmentBackup(1, f.deps)).toThrow();
    markDevelopmentBackupRestored(f.deps);
    expect(finishDevelopmentBackup(1, f.deps).resumed).toBe(true);
  });
  it('permits normal boot reconstruction of lost runtime only after explicit coordinated restore', () => {
    const f = fixture(); beginDevelopmentBackup(1, f.deps, f.api.runtimeDigest);
    rmSync(f.dir, { recursive: true });
    expect(() => finishDevelopmentBackup(1, f.deps)).toThrow();
    expect(existsSync(f.deps.holdPath)).toBe(true);
    markDevelopmentBackupRestored(f.deps);
    expect(finishDevelopmentBackup(1, f.deps)).toMatchObject({ resumed: false, bootResumeRequired: true });
    expect(f.calls.some(call => call.includes(' up '))).toBe(false);
  });
  it('never blesses a restore of incompatible API or selection state', () => {
    const f = fixture(); beginDevelopmentBackup(1, f.deps, f.api.runtimeDigest);
    expect(() => fenceDevelopmentBackup(1, f.deps, `sha256:${'f'.repeat(64)}`)).toThrow('incompatible');
    f.api.runtimeDigest = `sha256:${'f'.repeat(64)}`;
    expect(() => markDevelopmentBackupRestored(f.deps)).toThrow('does not match');
    expect(developmentBackupStatus(f.deps)?.phase).toBe('held');
  });
});

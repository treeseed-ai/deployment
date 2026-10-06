import { describe, expect, it } from 'vitest';
import { assertWorkspaceRecoveryIdle, workspaceRecoveryInventory } from '../src/sandbox/workspace-build-recovery.js';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { WorkspaceCatalog } from '../src/sandbox/workspace-catalog.js';
import { retainUnpublishedWork } from '../src/sandbox/assignment-source-store.js';

describe('workspace build recovery', () => {
  it('automatically discards stopped failed simulations but retains unpublished production and successful candidates', () => {
    const simulation = { mode: 'work', acquisition: 'simulation-local', publication: 'simulation-branch' };
    for (const status of ['failed', 'cancelled', 'expired', undefined]) expect(retainUnpublishedWork(simulation, status)).toBe(false);
    expect(retainUnpublishedWork(simulation, 'completed')).toBe(true);
    for (const status of ['completed', 'failed', undefined]) expect(retainUnpublishedWork({ mode: 'work', acquisition: 'upstream-authorized', publication: 'assignment-branch' }, status)).toBe(true);
  });
  it('requires both guest and lease absence', () => {
    expect(() => assertWorkspaceRecoveryIdle('', 0)).not.toThrow();
    expect(() => assertWorkspaceRecoveryIdle('sandbox-warm-example', 0)).toThrow();
    expect(() => assertWorkspaceRecoveryIdle('', 1)).toThrow();
    expect(() => assertWorkspaceRecoveryIdle('', -1)).toThrow();
  });
  it('releases transport through its owning unit without broker raw-device access', () => {
    const source = readFileSync(new URL('../src/sandbox/workspace-block-store.ts', import.meta.url), 'utf8');
    expect(source).not.toContain("['--disconnect', disk.device]");
    expect(source).toContain("['stop', disk.unit]");
    expect(source).toContain('Workspace NBD process ownership changed.');
  });
  it('initializes empty recovery inventory through the original catalog and replays without inventing work', () => {
    const root = mkdtempSync(join(tmpdir(), 'deployment-recovery-empty-'));
    try {
      expect(workspaceRecoveryInventory(root)).toEqual({ active: 0, builds: [] });
      const bytes = readFileSync(join(root, 'catalog.db'));
      expect(workspaceRecoveryInventory(root)).toEqual({ active: 0, builds: [] });
      expect(readFileSync(join(root, 'catalog.db'))).toEqual(bytes);
      for (const name of ['leases', 'jobs']) expect(readdirSync(join(root, name))).toEqual([]);
    } finally { rmSync(root, { recursive: true }); expect(existsSync(root)).toBe(false); }
  });
  it('retains corrupt recovery catalog bytes and denies initialization instead of replacing failed history', () => {
    const root = mkdtempSync(join(tmpdir(), 'deployment-recovery-corrupt-'));
    const bytes = Buffer.from('retained invalid SQLite input');
    try {
      writeFileSync(join(root, 'catalog.db'), bytes, { mode: 0o600 });
      expect(() => workspaceRecoveryInventory(root)).toThrow();
      expect(readFileSync(join(root, 'catalog.db'))).toEqual(bytes);
    } finally { rmSync(root, { recursive: true }); expect(existsSync(root)).toBe(false); }
  });
  it('native independent recovery process initializes fresh canonical storage and retains interrupted build ownership on retry', () => {
    const root = mkdtempSync(join(tmpdir(), 'deployment-recovery-native-'));
    const module = new URL('../src/sandbox/workspace-build-recovery.ts', import.meta.url).href;
    const program = `const {workspaceRecoveryInventory} = await import(process.argv[1]); console.log(JSON.stringify(workspaceRecoveryInventory(process.argv[2])));`;
    const inspect = () => {
      const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', program, module, root],
        { encoding: 'utf8', timeout: 5_000 });
      expect(child.error).toBeUndefined(); expect(child.signal).toBeNull(); expect(child.status, child.stderr).toBe(0);
      return JSON.parse(child.stdout);
    };
    try {
      expect(inspect()).toEqual({ active: 0, builds: [] });
      const catalog = new WorkspaceCatalog(join(root, 'catalog.db'));
      let id: string, jobId: string;
      try {
        id = catalog.ensure({ controlPlaneId: 'plane', teamId: 'team', projectId: 'project', repositoryId: 'repo',
          commit: 'a'.repeat(40), formatVersion: 1, profile: 'source-only' }).id;
        jobId = catalog.claimBuild(id).jobId;
      } finally { catalog.close(); }
      const bytes = readFileSync(join(root, 'catalog.db'));
      for (let retry = 0; retry < 2; retry++) {
        expect(inspect()).toEqual({ active: 0, builds: [{ id, job_id: jobId }] });
        expect(readFileSync(join(root, 'catalog.db'))).toEqual(bytes);
      }
      for (const name of ['leases', 'jobs']) expect(readdirSync(join(root, name))).toEqual([]);
    } finally { rmSync(root, { recursive: true }); expect(existsSync(root)).toBe(false); }
  });
});

import { describe, expect, it } from 'vitest';
import { assertWorkspaceRecoveryIdle } from '../src/sandbox/workspace-build-recovery.js';
import { readFileSync } from 'node:fs';
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
});

import { describe, expect, it } from 'vitest';
import { assertWorkspaceRecoveryIdle } from '../src/sandbox/workspace-build-recovery.js';
import { readFileSync } from 'node:fs';

describe('workspace build recovery', () => {
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

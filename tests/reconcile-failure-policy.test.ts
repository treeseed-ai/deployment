import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { reconcileFailurePolicy, requireAutomaticRollback, serializedReconcileArguments } from '../src/manager/serialized-reconcile.js';

describe('explicit reconciliation failure policy',()=>{
  it('preserves normal rollback and rejects unknown policies',()=>{
    expect(reconcileFailurePolicy(undefined)).toBe('rollback');
    expect(reconcileFailurePolicy('halt')).toBe('halt');
    expect(()=>reconcileFailurePolicy('ignore')).toThrow();
    expect(serializedReconcileArguments()).not.toContain('--failure-policy=halt');
    expect(serializedReconcileArguments(undefined,false,[],'halt')).toContain('--failure-policy=halt');
  });
  it('prevents every automatic rollback action after a requested halt',()=>{
    const restore=vi.fn(),installOld=vi.fn(),activateOld=vi.fn();
    const recover=(policy:'halt'|'rollback')=>{requireAutomaticRollback(policy);restore();installOld();activateOld();};
    expect(()=>recover('halt')).toThrow('Reconciliation halted');
    for(const action of [restore,installOld,activateOld])expect(action).not.toHaveBeenCalled();
    recover('rollback');for(const action of [restore,installOld,activateOld])expect(action).toHaveBeenCalledOnce();
    const source=readFileSync('src/manager/reconcile.ts','utf8');
    const guard=source.indexOf('requireAutomaticRollback(failurePolicy);');
    expect(guard).toBeGreaterThan(source.indexOf('await stopComponent(component); } catch'));
    expect(guard).toBeLessThan(source.indexOf("operation: 'recovery.restore'"));
    expect(guard).toBeLessThan(source.indexOf('const rollbackPackages ='));
  });
});

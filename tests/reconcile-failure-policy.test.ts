import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { reconcileFailurePolicy, requireAutomaticRollback, serializedReconcileArguments, failurePolicyForDisabledComponents } from '../src/manager/serialized-reconcile.js';

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
    const guard=source.indexOf('requireAutomaticRollback(rollbackPolicy);');
    expect(guard).toBeGreaterThan(source.indexOf('await stopComponent(component); } catch'));
    expect(guard).toBeLessThan(source.indexOf("operation: 'recovery.restore'"));
    expect(guard).toBeLessThan(source.indexOf('const rollbackPackages ='));
  });
  it('halts instead of reviving a previously active component now disabled by the operator',()=>{
    expect(failurePolicyForDisabledComponents('rollback',true)).toBe('halt');
    expect(failurePolicyForDisabledComponents('rollback',false)).toBe('rollback');
    expect(failurePolicyForDisabledComponents('halt',false)).toBe('halt');
    const source=readFileSync('src/manager/reconcile.ts','utf8');
    expect(source).toContain('componentActivationOrder(host, active.filter(component => host.components[component.componentId]?.enabled === true))');
    expect(source).toContain('previous && !disabledPreviouslyActive');
    expect(source).toContain('failurePolicyForDisabledComponents(failurePolicy, disabledPreviouslyActive)');
    const operations=readFileSync('src/manager/operations.ts','utf8');
    expect(operations).toContain('hostDoctor(() => current, subjectAlternativeNames(current.routes)');
  });
});

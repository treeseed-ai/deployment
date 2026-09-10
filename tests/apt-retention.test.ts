import { describe, expect, it } from 'vitest';
import { retentionPlan, selectRollbackTag, type Package, type Archive } from '../scripts/apt-retention.js';

const pkg = (name: string, version: string, depends = ''): Package => ({ name: `${name}_${version}_all.deb`, package: name, version, depends, size: 10, digest: `sha256:${name}-${version}` });
const archive = (p: Package): Archive => ({ name: p.name, size: p.size, digest: p.digest, url: `https://github.com/treeseed-ai/deployment/releases/download/test/${p.name}` });
const matches = (v: string, op: string, required: string) => op === '=' && v === required;
describe('APT generation retention', () => {
  it('does not confuse the last published candidate with accepted rollback custody', () => {
    expect(selectRollbackTag('0.1.0-rc.294', { rollbackTag: '0.1.0-rc.291' })).toBe('0.1.0-rc.291');
    expect(selectRollbackTag('0.1.0-rc.294', { rollbackTag: '0.1.0-rc.291' }, '0.1.0-rc.293')).toBe('0.1.0-rc.293');
    expect(() => selectRollbackTag('0.1.0-rc.294', undefined)).toThrow('accepted rollback');
    expect(() => selectRollbackTag('0.1.0-rc.294', { rollbackTag: '0.1.0-rc.294' })).toThrow('accepted rollback');
  });
  it('retains a content-addressed rollback artifact even when versioned filenames were reused', () => {
    const current = pkg('treeseed-manager', '3');
    const prior = { ...current, name: 'treeseed-archive-old.deb', digest: 'sha256:older-build' };
    const archivedPrior = { ...archive(prior), name: current.name };
    expect(retentionPlan([current, prior], [archive(current)], [archivedPrior], [], matches).keep).toEqual([current, prior]);
  });
  it('matches GitHub-normalized filenames only with equal digests and sizes, retaining one pool copy', () => {
    const p = pkg('treeseed-manager', '1~rc3'); const copy = { ...p, name: p.name.replace('~', '.') };
    const previous = pkg('treeseed-manager', '1~rc2');
    const a = { ...archive(p), name: copy.name };
    const plan = retentionPlan([p, copy, previous], [a], [{ ...archive(previous), name: previous.name.replace('~', '.') }], [a], matches);
    expect(plan.keep).toEqual([copy, previous]); expect(plan.remove.map(p => p.name)).toEqual([p.name]);
  });
  it('retains both complete generations and archives only historical packages', () => {
    const current = [pkg('treeseed-manager', '3', 'treeseed-sdk (= 2)'), pkg('treeseed-sdk', '2')];
    const previous = [pkg('treeseed-manager', '2', 'treeseed-sdk (= 1)'), pkg('treeseed-sdk', '1')];
    const old = pkg('treeseed-manager', '1'); const all = [...current, ...previous, old];
    const plan = retentionPlan(all, current.map(archive), previous.map(archive), all.map(archive), matches);
    expect(plan.keep).toHaveLength(4); expect(plan.remove.map(p => p.name)).toEqual([old.name]);
    expect(plan.afterBytes).toBe(40);
    expect(retentionPlan(plan.keep, current.map(archive), previous.map(archive), all.map(archive), matches).remove).toEqual([]);
  });
  it('rejects incomplete rollback dependency closure', () => {
    const current = pkg('treeseed-manager', '3'); const previous = pkg('treeseed-manager', '2', 'treeseed-sdk (= 1)');
    expect(() => retentionPlan([current, previous], [archive(current)], [archive(previous)], [], matches)).toThrow('closure');
  });
  it('never removes a sole copy or a mismatched archive', () => {
    const all = [pkg('treeseed-manager', '3'), pkg('treeseed-manager', '2'), pkg('treeseed-manager', '1')];
    expect(() => retentionPlan(all, [archive(all[0]!)], [archive(all[1]!)], [{ ...archive(all[2]!), digest: 'wrong' }], matches)).toThrow('verified release archive');
  });
  it('requires complete, digest-bound current and rollback roots', () => {
    const p = pkg('treeseed-manager', '3');
    expect(() => retentionPlan([p], [archive(p)], [], [], matches)).toThrow('Both complete');
    expect(() => retentionPlan([p], [archive(p)], [{ ...archive(p), size: 99 }], [], matches)).toThrow('missing or changed');
  });
});

import { chmodSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import { PostgresTransitionStore } from '../src/postgres/transition-store.js';
const roots: string[] = [], hash = (value: string) => `sha256:${value.repeat(64)}`;
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'treeseed-transition-store-')); roots.push(root);
  const selection = { componentId: 'api', sourceRuntimeDigest: hash('a'), targetRuntimeDigest: hash('b'),
    topologyDigest: hash('c'), configurationDigest: hash('d'), allowLocaleConversion: false };
  const binding = { componentId: 'api', requirementId: 'api', sourceRuntimeDigest: hash('a'), targetRuntimeDigest: hash('b'),
    topologyDigest: hash('c'), intentDigest: hash('e'), planDigest: hash('f') };
  return { root, store: new PostgresTransitionStore(root), selection, binding };
}
it('preserves exact preparation and rejects implicit expansion of locale permission', () => {
  const f = fixture(), prepared = f.store.prepare(f.selection);
  expect(prepared.action).toBe('prepared'); expect(f.store.prepare(f.selection).action).toBe('noop');
  expect(f.store.preparation(prepared.selectionDigest)).toEqual(f.selection);
  expect(f.store.preparation(deploymentDigest({ ...f.selection, allowLocaleConversion: true }))).toBeNull();
  expect(() => f.store.prepare({ ...f.selection, path: '/unowned' })).toThrow();
});
it('switches exactly once, accepts by CAS and preserves the record across restart', () => {
  const f = fixture(), switched = f.store.switch(f.binding);
  expect(() => f.store.switch(f.binding)).toThrow('compare-and-swap');
  expect(() => f.store.accept('api', hash('0'))).toThrow('compare-and-swap');
  f.store.accept('api', switched.bindingDigest);
  expect(new PostgresTransitionStore(f.root).binding('api')).toEqual({ ...f.binding, state: 'accepted', version: 2 });
  expect(() => f.store.accept('api', switched.bindingDigest)).toThrow('compare-and-swap');
  expect(readdirSync(f.root)).toEqual(['binding-api.json']);
});
it.each(['mode', 'hardlink', 'symlink', 'corrupt'] as const)('rejects %s custody without overwriting it', failure => {
  const f = fixture(); f.store.switch(f.binding);
  const path = join(f.root, 'binding-api.json');
  if (failure === 'mode') chmodSync(path, 0o644);
  if (failure === 'hardlink') linkSync(path, join(f.root, 'other'));
  if (failure === 'symlink') { rmSync(path); symlinkSync('missing', path); }
  if (failure === 'corrupt') writeFileSync(path, '{}');
  expect(() => f.store.binding('api')).toThrow();
  expect(() => f.store.switch(f.binding)).toThrow();
  if (failure === 'corrupt') expect(readFileSync(path, 'utf8')).toBe('{}');
});

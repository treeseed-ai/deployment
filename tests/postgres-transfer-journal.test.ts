import { mkdtempSync, rmSync, writeFileSync, symlinkSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { PostgresTransferJournal } from '../src/postgres/transfer-journal.js';
import { assertPostgresTransferNotHeld } from '../src/core/postgres-transfer-hold.js';

const roots: string[] = [];
const digest = (value: string) => `sha256:${value.repeat(64)}`;
const intent = { intentDigest: digest('a'), restoreGeneration: 123, restoreDigest: digest('b') };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'treeseed-transfer-journal-')); roots.push(root);
  return { root, journal: new PostgresTransferJournal(root), marker: join(root, 'active.json') };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('persists exact phases and clears activation hold only after durable acceptance', async () => {
  const f = fixture();
  await f.journal.locked(async () => {
    f.journal.begin(intent); expect(() => assertPostgresTransferNotHeld(f.marker)).toThrow('holds');
    for (const stage of ['export','restore','verify','switch','activate','accepted'] as const)
      f.journal.advance(intent.intentDigest, stage, stage === 'restore' ? digest('c') : undefined);
  });
  expect(f.journal.accepted(intent.intentDigest)).toBe(true); expect(f.journal.active()).toBeNull();
  expect(() => assertPostgresTransferNotHeld(f.marker)).not.toThrow();
  expect(readFileSync(join(f.root, `${'a'.repeat(64)}.json`), 'utf8')).not.toContain('password');
});
it('reopened journal retains an interrupted hold and prohibits retry or competing intents', () => {
  const f = fixture(); f.journal.begin(intent);
  const reopened = new PostgresTransferJournal(f.root);
  expect(reopened.active()?.stage).toBe('fencing');
  expect(() => reopened.begin(intent)).toThrow('recovery');
  expect(() => reopened.begin({ ...intent, intentDigest: digest('d') })).toThrow('recovery');
});
it('rejects phase skips, wrong intent and import without encrypted archive identity', () => {
  const f = fixture(); f.journal.begin(intent);
  expect(() => f.journal.advance(intent.intentDigest, 'switch')).toThrow('phase');
  expect(() => f.journal.advance(digest('c'), 'export')).toThrow('Exact active');
  f.journal.advance(intent.intentDigest, 'export');
  expect(() => f.journal.advance(intent.intentDigest, 'restore')).toThrow('archive');
  expect(f.journal.active()?.stage).toBe('export');
});
it('requires the exact authenticated recovery point and never resumes failed transfer implicitly', () => {
  const f = fixture(); f.journal.begin(intent); f.journal.advance(intent.intentDigest, 'recovery-required');
  expect(() => f.journal.advance(intent.intentDigest, 'export')).toThrow('phase');
  expect(() => f.journal.restored(124, 'b'.repeat(64))).toThrow('restore point');
  expect(() => f.journal.restored(123, 'c'.repeat(64))).toThrow('restore point');
  expect(f.journal.active()).not.toBeNull();
  f.journal.restored(123, 'b'.repeat(64));
  expect(f.journal.active()).toBeNull(); expect(f.journal.accepted(intent.intentDigest)).toBe(false);
  expect(() => f.journal.begin(intent)).toThrow('recovery');
});
it('fails closed for corrupt, symlinked and writable marker files', () => {
  for (const kind of ['corrupt','symlink','permissions']) {
    const f = fixture();
    if (kind === 'symlink') symlinkSync('/nonexistent', f.marker);
    else { writeFileSync(f.marker, kind === 'corrupt' ? '{}' : JSON.stringify({ ...intent, schemaVersion: 'treeseed.postgres-transfer-journal/v1', stage: 'fencing' }), { mode: 0o600 });
      if (kind === 'permissions') chmodSync(f.marker, 0o666); }
    expect(() => f.journal.active()).toThrow();
    expect(() => assertPostgresTransferNotHeld(f.marker)).toThrow();
  }
});

import { expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { restorePostgresLogicalArchive, writePostgresLogicalArchive } from '../src/postgres/logical-archive.js';

const intent = `sha256:${'a'.repeat(64)}`;
const other = `sha256:${'b'.repeat(64)}`;
const filename = `${'a'.repeat(64)}.pgdump.enc`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'postgres-archive-')), key = randomBytes(32);
  const bytes = Buffer.from('private test database content');
  const write = () => writePostgresLogicalArchive(root, intent, key, Readable.from([bytes]), Promise.resolve());
  return { root, key, bytes, write, clean: () => { key.fill(0); rmSync(root, { recursive: true, force: true }); } };
}
it('streams an authenticated intent-bound archive without plaintext on disk or modifying caller key', async () => {
  const f = fixture(), retained = Buffer.from(f.key);
  try {
    const archive = await f.write(); const chunks: Buffer[] = [];
    expect(readFileSync(join(f.root, filename)).includes(f.bytes)).toBe(false);
    await restorePostgresLogicalArchive(f.root, intent, f.key, archive, async () => ({
      input: new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }), completed: Promise.resolve(),
    }));
    expect(Buffer.concat(chunks)).toEqual(f.bytes); expect(f.key).toEqual(retained);
    expect(readdirSync(f.root)).toEqual([filename]);
    await expect(f.write()).rejects.toThrow('export failed');
    expect(readdirSync(f.root)).toEqual([filename]);
  } finally { f.clean(); retained.fill(0); }
});
it.each(['ciphertext', 'tag-with-updated-digest', 'truncated', 'key', 'intent', 'symlink', 'hardlink', 'permissions'])('rejects %s before opening destination', async mode => {
  const f = fixture(); let opened = false;
  try {
    const archive = await f.write(), path = join(f.root, filename);
    if (mode === 'ciphertext' || mode === 'tag-with-updated-digest' || mode === 'truncated') {
      let data = readFileSync(path); data[data.length - 1] = data[data.length - 1]! ^ 1;
      if (mode === 'truncated') data = data.subarray(0, 16);
      writeFileSync(path, data);
      if (mode !== 'ciphertext') archive.digest = `sha256:${createHash('sha256').update(data).digest('hex')}`;
    }
    if (mode === 'key') f.key.fill(0);
    if (mode === 'intent') archive.intentDigest = other;
    if (mode === 'permissions') chmodSync(path, 0o644);
    if (mode === 'hardlink') linkSync(path, join(f.root, 'other'));
    if (mode === 'symlink') { const data = readFileSync(path); rmSync(path); writeFileSync(join(f.root, 'other'), data); symlinkSync(join(f.root, 'other'), path); }
    await expect(restorePostgresLogicalArchive(f.root, intent, f.key, archive, async () => {
      opened = true; throw new Error('secret value');
    })).rejects.toThrow('authenticated restore failed');
    expect(opened).toBe(false);
    expect(readdirSync(f.root).some(name => name.startsWith('.logical-'))).toBe(false);
  } finally { f.clean(); }
});
it('rejects a failed producer even when it emitted a complete-looking stream', async () => {
  const f = fixture();
  try {
    await expect(writePostgresLogicalArchive(f.root, intent, f.key, Readable.from([f.bytes]), Promise.reject(new Error('secret dump error')))).rejects.toThrow('export failed');
    expect(readdirSync(f.root)).toEqual([]);
  } finally { f.clean(); }
});
it('uses the verified private ciphertext snapshot if the original is replaced', async () => {
  const f = fixture(); const chunks: Buffer[] = [];
  try {
    const archive = await f.write();
    await restorePostgresLogicalArchive(f.root, intent, f.key, archive, async () => {
      writeFileSync(join(f.root, filename), 'replaced input');
      return { input: new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }), completed: Promise.resolve() };
    });
    expect(Buffer.concat(chunks)).toEqual(f.bytes);
  } finally { f.clean(); }
});
it('redacts destination process failures and removes private snapshots', async () => {
  const f = fixture();
  try {
    const archive = await f.write();
    await expect(restorePostgresLogicalArchive(f.root, intent, f.key, archive, async () => ({
      input: new Writable({ write(_chunk, _encoding, done) { done(); } }), completed: Promise.reject(new Error('database password')),
    }))).rejects.toThrow('authenticated restore failed');
    expect(readdirSync(f.root)).toEqual([filename]);
  } finally { f.clean(); }
});

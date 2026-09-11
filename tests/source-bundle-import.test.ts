import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { sourceCandidateChunkBytes } from '@treeseed/sdk/capacity-provider/sandbox';
import { SourceBundleImport } from '../src/sandbox/source-bundle-import.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sha = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'treeseed-source-import-')); roots.push(root);
  const bytes = Buffer.alloc(sourceCandidateChunkBytes + 3, 8), parts = [bytes.subarray(0, sourceCandidateChunkBytes), bytes.subarray(sourceCandidateChunkBytes)];
  const bundle = { artifactId: 'candidate', digest: sha(bytes), bytes: bytes.length, chunks: parts.map(sha) };
  const importer = new SourceBundleImport(bundle, root);
  const chunk = (index: number) => ({ artifactId: bundle.artifactId, index, digest: bundle.chunks[index], content: parts[index]!.toString('base64') });
  return { root, bytes, bundle, importer, chunk };
}
it('imports out of order, validates all bytes and replays without overwriting immutable input', async () => {
  const f = await fixture();
  expect((await f.importer.write(f.chunk(1))).ready).toBe(false);
  expect((await f.importer.write(f.chunk(1))).received).toBe(1);
  expect((await f.importer.write(f.chunk(0))).ready).toBe(true);
  expect(await readFile(join(f.root, `${f.bundle.digest.slice(7)}.bundle`))).toEqual(f.bytes);
  expect((await f.importer.write(f.chunk(0))).ready).toBe(true);
});
it.each(['artifact', 'digest', 'index', 'bytes'] as const)('rejects %s mismatch before staging', async invalid => {
  const f = await fixture(), chunk = f.chunk(0);
  if (invalid === 'artifact') chunk.artifactId = 'other';
  if (invalid === 'digest') chunk.digest = `sha256:${'a'.repeat(64)}`;
  if (invalid === 'index') chunk.index = 3;
  if (invalid === 'bytes') chunk.content = Buffer.from('corrupt').toString('base64');
  await expect(f.importer.write(chunk)).rejects.toThrow(); expect(f.importer.status().received).toBe(0);
});
it('refuses a mismatched full-bundle digest even when each chunk is correct', async () => {
  const f = await fixture(); f.bundle.digest = `sha256:${'a'.repeat(64)}`;
  await f.importer.write(f.chunk(0)); await expect(f.importer.write(f.chunk(1))).rejects.toThrow('final integrity');
  expect(f.importer.status().ready).toBe(false);
  expect(f.importer.status().failed).toBe(true);
  await expect(f.importer.write(f.chunk(0))).rejects.toThrow('fenced');
});

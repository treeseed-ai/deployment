import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sourceCandidateChunkBytes, sourceChunkResponseSchema, type SourceWorkspaceResponse } from '@treeseed/sdk/capacity-provider/sandbox';

type Bundle = NonNullable<SourceWorkspaceResponse['sourceBundle']>;
const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Host-authenticated chunk transfer into an immutable builder input; never Git-fetch an unpublished candidate. */
export class SourceBundleImport {
  private readonly received = new Set<number>();
  private ready = false;
  private locked = false;
  private failed = false;
  private path: string | undefined;
  constructor(readonly bundle: Bundle, private readonly root: string) {}
  status() { return { ready: this.ready, failed: this.failed, received: this.received.size, chunks: this.bundle.chunks.length }; }
  async write(value: unknown) {
    if (this.failed) throw new Error('Source import is fenced after integrity failure.');
    if (this.locked) throw new Error('Source chunk custody is busy; retry sequentially.');
    this.locked = true;
    try {
      const chunk = sourceChunkResponseSchema.parse(value), bytes = Buffer.from(chunk.content, 'base64');
      if (chunk.artifactId !== this.bundle.artifactId || chunk.index >= this.bundle.chunks.length
        || chunk.digest !== this.bundle.chunks[chunk.index] || digest(bytes) !== chunk.digest || bytes.toString('base64') !== chunk.content
        || bytes.length !== Math.min(sourceCandidateChunkBytes, this.bundle.bytes - chunk.index * sourceCandidateChunkBytes)) throw new Error('Source chunk differs from the authorized candidate.');
      if (this.ready || this.received.has(chunk.index)) return this.status();
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const info = await lstat(this.root);
      if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) || await realpath(this.root) !== this.root) throw new Error('Source import requires private manager custody.');
      if (!this.path) {
        const path = join(this.root, `import-${randomUUID()}.partial`), file = await open(path, 'wx', 0o600);
        await file.close(); this.path = path;
      }
      const file = await open(this.path, constants.O_RDWR | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()) throw new Error('Source import file escaped custody.');
        let written = 0;
        while (written < bytes.length) { const result = await file.write(bytes, written, bytes.length - written, chunk.index * sourceCandidateChunkBytes + written); if (!result.bytesWritten) throw new Error('Source chunk write failed.'); written += result.bytesWritten; }
        await file.sync(); this.received.add(chunk.index);
        if (this.received.size === this.bundle.chunks.length) {
          const hash = createHash('sha256');
          for await (const data of file.createReadStream({ autoClose: false, start: 0 })) hash.update(data as Buffer);
          if ((await file.stat()).size !== this.bundle.bytes || `sha256:${hash.digest('hex')}` !== this.bundle.digest) {
            this.failed = true;
            throw new Error('Source bundle failed final integrity verification.');
          }
        }
      } finally { await file.close(); }
      if (this.received.size === this.bundle.chunks.length) {
        const destination = join(this.root, `${this.bundle.digest.slice(7)}.bundle`);
        await chmod(this.path, 0o400);
        try { await link(this.path, destination); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const existing = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const stat = await existing.stat(), hash = createHash('sha256');
            if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size !== this.bundle.bytes || (stat.mode & 0o222)) throw new Error('Existing source bundle is unsafe.');
            for await (const data of existing.createReadStream({ autoClose: false })) hash.update(data as Buffer);
            if (`sha256:${hash.digest('hex')}` !== this.bundle.digest) throw new Error('Existing source bundle is corrupt.');
          } finally { await existing.close(); }
        }
        await rm(this.path); this.path = undefined;
        const directory = await open(this.root, 'r'); try { await directory.sync(); } finally { await directory.close(); }
        this.ready = true;
      }
      return this.status();
    } finally { this.locked = false; }
  }
}

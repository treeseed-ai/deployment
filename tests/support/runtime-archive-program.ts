import assert from 'node:assert/strict';
import * as sandbox from '@treeseed-cordis/deployment/sandbox';
import { mkdtempSync, writeFileSync, realpathSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export interface RuntimeArchiveHandle {
  readonly proof: { sha256: string; size: number };
  verify(): void;
  close(): void;
}
export interface RuntimeArchiveFactory {
  open(input: unknown, signal: AbortSignal): Promise<RuntimeArchiveHandle>;
}
/** Genuine small Zstandard frame, not a Kata kit or runtime compatibility claim. */
export class RuntimeArchiveFixture {
  static readonly bytes = Buffer.from(
    'KLUv/SAqUQEAVHJlZVNlZWQgcnVudGltZSBhcmNoaXZlIGlkZW50aXR5IGZpeHR1cmUK',
    'base64',
  );
  readonly directory = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-archive-')));
  readonly path = join(this.directory, 'runtime.tar.zst');
  readonly input = {
    path: this.path,
    sha256: createHash('sha256').update(RuntimeArchiveFixture.bytes).digest('hex'),
    size: RuntimeArchiveFixture.bytes.length,
  };
  constructor() {
    this.write();
  }
  write(): void {
    writeFileSync(this.path, RuntimeArchiveFixture.bytes, { mode: 0o600 });
  }
  static async api(): Promise<RuntimeArchiveFactory> {
    assert.equal(typeof Reflect.get(sandbox, 'RuntimeArchiveCustody'), 'function');
    return Reflect.get(sandbox, 'RuntimeArchiveCustody') as RuntimeArchiveFactory;
  }
  async open(signal = new AbortController().signal): Promise<RuntimeArchiveHandle> {
    return (await RuntimeArchiveFixture.api()).open(this.input, signal);
  }
  close(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
}
class RuntimeArchiveProgram {
  async run(): Promise<void> {
    const fixture = new RuntimeArchiveFixture();
    let file: RuntimeArchiveHandle | null = null;
    try {
      file = await fixture.open();
      assert.deepEqual(file.proof, { sha256: fixture.input.sha256, size: fixture.input.size });
      assert(Object.isFrozen(file.proof));
      file.verify();
      renameSync(fixture.path, fixture.path + '.held');
      fixture.write();
      assert.throws(file.verify.bind(file), { code: 'KATA_RUNTIME_ARCHIVE_CHANGED' });
      file.close();
      assert.throws(file.verify.bind(file), { code: 'KATA_RUNTIME_ARCHIVE_CLOSED' });
    } finally {
      file?.close();
      fixture.close();
    }
    process.stdout.write('runtime-archive-custody-ok\n');
  }
}
if (import.meta.main) await new RuntimeArchiveProgram().run();

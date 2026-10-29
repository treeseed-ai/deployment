import assert from 'node:assert/strict';
import { Header, type HeaderData } from 'tar';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PackageArchiveMaterializer } from '@treeseed-cordis/deployment';
/** Genuine compressed data archive; scripts are output canaries, never executable fixtures. */
export class CooperativePackageFixture {
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), 'cooperative-package-')));
  readonly target = join(this.root, 'target');
  readonly archive = join(this.root, 'package.tgz');
  readonly canary = join(this.root, 'MUST_NOT_EXECUTE');
  readonly expected = new Map<string, Buffer>();
  readonly digest: string;
  private active = false;
  private partialTurns = 0;
  constructor(mode = 'valid') {
    mkdirSync(this.target, { mode: 0o700 });
    const bytes = this.package(mode);
    this.digest = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(
      this.archive,
      mode === 'tamper' ? Buffer.concat([bytes, Buffer.from('changed')]) : bytes,
      { mode: 0o600 },
    );
  }
  private package(mode: string): Buffer {
    const parts: Buffer[] = [];
    const metadata = Buffer.from(
      JSON.stringify({
        name: 'cooperative-package-fixture',
        version: '1.0.0',
        scripts: { preinstall: 'touch ' + this.canary },
      }),
    );
    this.entry(parts, 'package.json', metadata);
    for (let index = 0; index < 512; index++)
      this.entry(
        parts,
        'file-' + index + '.txt',
        Buffer.from('explicit package fixture ' + index + '\n'),
      );
    this.invalid(parts, mode);
    return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
  }
  private entry(parts: Buffer[], name: string, bytes: Buffer): void {
    const header = Buffer.alloc(512);
    new Header({ type: 'File', path: 'package/' + name, mode: 0o644, size: bytes.length }).encode(
      header,
    );
    parts.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
    this.expected.set(name, bytes);
  }
  private invalid(parts: Buffer[], mode: string): void {
    if (mode === 'duplicate') this.entry(parts, 'file-0.txt', Buffer.from('duplicate'));
    if (mode !== 'link' && mode !== 'traversal') return;
    const header = Buffer.alloc(512);
    const data: HeaderData =
      mode === 'link'
        ? { type: 'SymbolicLink', path: 'package/link', linkpath: 'file-0.txt' }
        : { type: 'File', path: 'package/../escape', size: 0 };
    new Header({ ...data, mode: 0o644 }).encode(header);
    parts.push(header);
  }
  async materialize(privateOutput = true): Promise<void> {
    this.active = true;
    setImmediate(this.observe.bind(this));
    try {
      if (privateOutput)
        await PackageArchiveMaterializer.materializePrivate(this.archive, this.digest, this.target);
      else await PackageArchiveMaterializer.materialize(this.archive, this.digest, this.target);
    } finally {
      this.active = false;
    }
  }
  private observe(): void {
    if (!this.active) return;
    const count = readdirSync(this.target).length;
    if (count > 0 && count < this.expected.size) this.partialTurns++;
    setImmediate(this.observe.bind(this));
  }
  verify(privateOutput = true): void {
    assert(
      this.partialTurns >= 2,
      'Bulk archive publication starved queued event-loop observations',
    );
    assert.equal(readdirSync(this.target).length, this.expected.size);
    for (const [name, bytes] of this.expected) {
      const file = join(this.target, name);
      assert(readFileSync(file).equals(bytes));
      assert.equal(statSync(file).mode & 0o777, privateOutput ? 0o600 : 0o644);
    }
    assert.equal(existsSync(this.canary), false);
  }
  close(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
class CooperativePackageProgram {
  async run(): Promise<void> {
    const fixture = new CooperativePackageFixture();
    try {
      await fixture.materialize();
      fixture.verify();
    } finally {
      fixture.close();
    }
    process.stdout.write('cooperative-package-public-ok\n');
  }
}
if (import.meta.main) await new CooperativePackageProgram().run();

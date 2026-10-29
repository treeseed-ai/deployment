import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  chmodSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { create } from 'tar';
import { GuestRuntimeBinding, type GuestRuntimeManifest } from '@treeseed-cordis/sdk';
import * as host from '@treeseed-cordis/deployment/sandbox';
interface RuntimeReader {
  read(signal: AbortSignal): Promise<{ manifest: GuestRuntimeManifest; executable: Buffer }>;
}
interface RuntimeConstructor {
  new (input: unknown): RuntimeReader;
}
/** Genuine NPM test archive; the pinned Bun ELF is a fixture, not an Agent program. */
export class GuestRuntimeFixture {
  static readonly libraries = [
    'ld-linux-x86-64.so.2',
    'libc.so.6',
    'libdl.so.2',
    'libm.so.6',
    'libpthread.so.0',
  ];
  readonly root = mkdtempSync(join(tmpdir(), 'guest-artifact-'));
  readonly source = join(this.root, 'source');
  readonly archive = join(this.root, 'guest.tgz');
  readonly canary = join(this.root, 'HOST_EXECUTION_CANARY');
  memberMode = 0o644;
  manifest!: GuestRuntimeManifest;
  bytes!: Buffer;
  constructor() {
    mkdirSync(join(this.source, 'package/dist/bin'), { recursive: true });
  }
  static identity(bytes: Buffer): { sha256: string; size: number } {
    return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  }
  async prepare(): Promise<this> {
    assert.equal(
      process.versions.bun,
      '1.4.4',
      'fixture requires the exact qualified Bun compiler',
    );
    const binary = readFileSync(process.execPath);
    const compressed = gzipSync(binary, { level: 1 });
    this.manifest = this.describe(binary, compressed);
    writeFileSync(
      join(this.source, 'package/dist/bin/guest-runtime.json'),
      JSON.stringify(this.manifest),
    );
    this.metadata();
    await this.pack();
    return this;
  }
  private describe(binary: Buffer, compressed: Buffer): GuestRuntimeManifest {
    const parts = this.parts(compressed);
    return GuestRuntimeBinding.assert({
      schemaVersion: 'treeseed.guest-runtime/v1',
      compiler: 'bun@1.4.4',
      target: 'bun-linux-x64-baseline',
      os: 'linux',
      architecture: 'amd64',
      interpreter: '/lib64/ld-linux-x86-64.so.2',
      requiredLibraries: GuestRuntimeFixture.libraries,
      compressed: { format: 'gzip', parts, ...GuestRuntimeFixture.identity(compressed) },
      executable: { mode: 0o755, ...GuestRuntimeFixture.identity(binary) },
    });
  }
  private parts(bytes: Buffer): object[] {
    const result: { file: string; size: number; sha256: string }[] = [];
    const limit = 7 * 1024 * 1024;
    for (let offset = 0; offset < bytes.length; offset += limit) {
      const file = 'trsd-agent-guest.' + String(result.length).padStart(3, '0') + '.gzpart';
      const part = bytes.subarray(offset, offset + limit);
      writeFileSync(join(this.source, 'package/dist/bin', file), part);
      result.push({ file, ...GuestRuntimeFixture.identity(part) });
    }
    return result;
  }
  private metadata(): void {
    writeFileSync(
      join(this.source, 'package/package.json'),
      JSON.stringify({
        name: '@fixture/guest-runtime',
        version: '1.0.0',
        scripts: {
          preinstall:
            'node -e ' +
            JSON.stringify(
              'require("node:fs").writeFileSync(' + JSON.stringify(this.canary) + ',"executed")',
            ),
        },
      }),
    );
  }
  async refresh(): Promise<void> {
    writeFileSync(
      join(this.source, 'package/dist/bin/guest-runtime.json'),
      JSON.stringify(this.manifest),
    );
    await this.pack();
  }
  async pack(): Promise<void> {
    chmodSync(join(this.source, 'package/package.json'), this.memberMode);
    chmodSync(join(this.source, 'package/dist/bin/guest-runtime.json'), this.memberMode);
    for (const part of this.manifest.compressed.parts)
      chmodSync(join(this.source, 'package/dist/bin', part.file), this.memberMode);
    await create({ gzip: true, cwd: this.source, file: this.archive, portable: false }, [
      'package',
    ]);
    chmodSync(this.archive, 0o600);
    this.bytes = readFileSync(this.archive);
  }
  configuration(): object {
    return {
      directory: this.root,
      archive: { path: 'guest.tgz', ...GuestRuntimeFixture.identity(this.bytes) },
      package: { name: '@fixture/guest-runtime', version: '1.0.0' },
    };
  }
  reader(input = this.configuration()): RuntimeReader {
    const Reader = Reflect.get(host, 'GuestRuntimeArchive') as RuntimeConstructor;
    assert.equal(typeof Reader, 'function', 'default public guest artifact reader must exist');
    return new Reader(input);
  }
  close(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
class GuestRuntimeProgram {
  async run(): Promise<void> {
    const fixture = await new GuestRuntimeFixture().prepare();
    try {
      const before = readdirSync(fixture.root).sort();
      const result = await fixture.reader().read(new AbortController().signal);
      assert.deepEqual(result.manifest, fixture.manifest);
      assert.deepEqual(
        { ...GuestRuntimeFixture.identity(result.executable), mode: 0o755 },
        fixture.manifest.executable,
      );
      assert.equal(existsSync(fixture.canary), false);
      assert.deepEqual(readdirSync(fixture.root).sort(), before);
      process.stdout.write('guest-artifact-ok\n');
    } finally {
      fixture.close();
    }
  }
}
if (import.meta.main) await new GuestRuntimeProgram().run();

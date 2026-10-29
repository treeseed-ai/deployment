import assert from 'node:assert/strict';
import { Header, type HeaderData } from 'tar';
import { zstdCompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Sandbox from '@treeseed-cordis/deployment/sandbox';
export interface ComponentCustody {
  readonly proof: object;
  verify(): void;
  close(): void;
}
export interface ComponentBindings {
  role: string;
  member: string;
  path: string;
}
interface ComponentConstructor {
  open(
    archive: Sandbox.RuntimeArchiveCustody,
    bindings: unknown,
    signal: AbortSignal,
  ): Promise<ComponentCustody>;
}
/** Genuine small kit and installed regular data; no executable runtime or extraction. */
export class ComponentFixture {
  readonly directory = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-components-')));
  readonly installed = join(this.directory, 'PRIVATE_COMPONENT_PATH');
  readonly bytes = Buffer.from('explicit installed component fixture\n');
  readonly input: { path: string; sha256: string; size: number };
  readonly bindings: ComponentBindings[];
  constructor() {
    writeFileSync(this.installed, this.bytes, { mode: 0o755 });
    const archive = zstdCompressSync(this.tar());
    const path = join(this.directory, 'fixture.tar.zst');
    writeFileSync(path, archive, { mode: 0o600 });
    this.input = { path, sha256: this.digest(archive), size: archive.length };
    this.bindings = [{ role: 'hypervisor', member: 'opt/kata/bin/alias', path: this.installed }];
  }
  private tar(): Buffer {
    return Buffer.concat([
      this.entry({ path: 'opt/kata/bin/component', mode: 0o755 }, this.bytes),
      this.entry({
        path: 'opt/kata/bin/alias',
        type: 'SymbolicLink',
        linkpath: 'component',
        mode: 0o777,
      }),
      Buffer.alloc(1024),
    ]);
  }
  private entry(input: HeaderData, bytes = Buffer.alloc(0)): Buffer {
    const header = Buffer.alloc(512);
    new Header({ type: 'File', mode: 0o644, size: bytes.length, ...input }).encode(header);
    return Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
  }
  digest(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
  }
  constructorExport(): ComponentConstructor {
    const value = Reflect.get(Sandbox, 'RuntimeComponentCustody') as
      | ComponentConstructor
      | undefined;
    assert(value && typeof value.open === 'function', 'Public installed component custody missing');
    return value;
  }
  close(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
}
class InstalledComponentsProgram {
  async run(): Promise<void> {
    const fixture = new ComponentFixture();
    let archive: Sandbox.RuntimeArchiveCustody | null = null;
    try {
      archive = await Sandbox.RuntimeArchiveCustody.open(
        fixture.input,
        new AbortController().signal,
      );
      await this.exercise(fixture, archive);
    } finally {
      archive?.close();
      fixture.close();
    }
    process.stdout.write('runtime-components-public-ok\n');
  }
  private async exercise(
    fixture: ComponentFixture,
    archive: Sandbox.RuntimeArchiveCustody,
  ): Promise<void> {
    const components = await fixture
      .constructorExport()
      .open(archive, fixture.bindings, new AbortController().signal);
    try {
      this.proof(fixture, components.proof);
      components.verify();
      components.close();
      components.close();
      archive.verify();
      assert.throws(components.verify.bind(components), { message: 'KATA_COMPONENTS_CLOSED' });
    } finally {
      components.close();
    }
  }
  private proof(fixture: ComponentFixture, proof: object): void {
    assert.deepEqual(proof, {
      formatVersion: 1,
      archive: { sha256: fixture.input.sha256, size: fixture.input.size },
      components: [
        {
          role: 'hypervisor',
          member: {
            requestedPath: 'opt/kata/bin/alias',
            path: 'opt/kata/bin/component',
            sha256: fixture.digest(fixture.bytes),
            size: fixture.bytes.length,
            mode: 0o755,
            links: [{ path: 'opt/kata/bin/alias', target: 'component' }],
          },
        },
      ],
    });
    assert(Object.isFrozen(proof));
    assert(!JSON.stringify(proof).includes(fixture.directory));
    assert(!JSON.stringify(proof).includes('PRIVATE_COMPONENT_PATH'));
  }
}
if (import.meta.main) await new InstalledComponentsProgram().run();

import assert from 'node:assert/strict';
import {
  readdirSync,
  lstatSync,
  readFileSync,
  renameSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { CooperativePackageFixture } from './cooperative-package-program.js';
/** Genuine public materialization; observes actual private files, never injected I/O. */
export class ParallelPackageFixture extends CooperativePackageFixture {
  private observing = false;
  maximum = 0;
  replaced = false;
  mutation: 'none' | 'conflict' | 'symlink' = 'none';
  private mutated = false;
  readonly displaced = this.target + '-original';
  async run(readable = false, replace = false): Promise<void> {
    this.observing = true;
    setImmediate(this.observePublications.bind(this, replace));
    try {
      await this.materialize(!readable);
    } finally {
      this.observing = false;
    }
  }
  private observePublications(replace: boolean): void {
    if (!this.observing) return;
    const count = readdirSync(this.target).filter(ParallelPackageFixture.temporary).length;
    this.maximum = Math.max(this.maximum, count);
    if (replace && count && !this.replaced) this.replace();
    if (count && !this.mutated && this.mutation !== 'none') this.interfere();
    setImmediate(this.observePublications.bind(this, replace));
  }
  private static temporary(name: string): boolean {
    return name.startsWith('.tmp-');
  }
  private replace(): void {
    renameSync(this.target, this.displaced);
    mkdirSync(this.target, { mode: 0o700 });
    writeFileSync(join(this.target, 'CANARY'), 'replacement must remain untouched', {
      mode: 0o600,
    });
    this.replaced = true;
  }
  private interfere(): void {
    const file = join(this.target, 'file-511.txt');
    if (this.mutation === 'conflict')
      writeFileSync(file, 'EXISTING_MEMBER_CANARY', { mode: 0o600, flag: 'wx' });
    else {
      const outside = join(this.root, 'OUTSIDE');
      writeFileSync(outside, 'OUTSIDE_MEMBER_CANARY', { mode: 0o600 });
      symlinkSync(outside, file);
    }
    this.mutated = true;
  }
  verified(readable = false): void {
    assert(this.maximum > 1, 'Durable archive publication remained serial');
    assert(this.maximum <= 8, 'Archive publication exceeded its eight-member bound');
    this.verify(!readable);
  }
  snapshot(directory = this.target): unknown {
    const result: Record<string, unknown> = {};
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      result[name] = lstatSync(path).isDirectory() ? this.snapshot(path) : readFileSync(path);
    }
    return result;
  }
}
class ParallelPackageProgram {
  async run(): Promise<void> {
    const fixture = new ParallelPackageFixture();
    try {
      await fixture.run();
      fixture.verified();
    } finally {
      fixture.close();
    }
    process.stdout.write('parallel-package-public-ok\n');
  }
}
if (import.meta.main) await new ParallelPackageProgram().run();

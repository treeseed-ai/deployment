import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as host from '@treeseed-cordis/deployment/sandbox';
import { GuestRuntimeFixture as Fixture } from '../support/guest-runtime-program.js';
interface ElfVerifier {
  verify(bytes: Buffer, input: { interpreter: string; requiredLibraries: string[] }): void;
}
class GuestRuntimeUnit {
  private verifier(): ElfVerifier {
    const value = Reflect.get(host, 'GuestRuntimeElf');
    assert.equal(typeof value, 'function', 'guest ELF verifier must be available');
    return value;
  }
  positive(): void {
    this.verifier().verify(readFileSync(process.execPath), this.requirements());
  }
  headers(): void {
    const verifier = this.verifier();
    const bytes = readFileSync(process.execPath);
    bytes.writeUInt16LE(183, 18);
    assert.throws(verifier.verify.bind(verifier, bytes, this.requirements()));
    for (const value of [Buffer.alloc(0), Buffer.alloc(64), bytes.subarray(0, 63)])
      assert.throws(verifier.verify.bind(verifier, value, this.requirements()));
  }
  dependencies(): void {
    const verifier = this.verifier();
    const bytes = readFileSync(process.execPath);
    for (const required of [[], ['libc.so.6'], [...Fixture.libraries, 'private-canary']])
      assert.throws(
        verifier.verify.bind(verifier, bytes, {
          ...this.requirements(),
          requiredLibraries: required,
        }),
      );
    assert.throws(
      verifier.verify.bind(verifier, bytes, {
        ...this.requirements(),
        interpreter: '/private-canary',
      }),
    );
  }
  strings(): void {
    const verifier = this.verifier();
    const bytes = readFileSync(process.execPath);
    const index = bytes.indexOf(Buffer.from('/lib64/ld-linux-x86-64.so.2'));
    assert(index > 0);
    bytes[index] = bytes[index]! | 0x80;
    assert.throws(verifier.verify.bind(verifier, bytes, this.requirements()));
  }
  bounds(): void {
    const verifier = this.verifier();
    const bytes = readFileSync(process.execPath);
    bytes.writeBigUInt64LE(0xffffffffffffffffn, 32);
    assert.throws(verifier.verify.bind(verifier, bytes, this.requirements()));
    bytes.writeBigUInt64LE(64n, 32);
    bytes.writeUInt16LE(65535, 56);
    assert.throws(verifier.verify.bind(verifier, bytes, this.requirements()));
  }
  configuration(): void {
    const Reader = Reflect.get(host, 'GuestRuntimeArchive');
    assert.equal(typeof Reader, 'function');
    const input = {
      directory: '/tmp',
      archive: { path: 'guest.tgz', size: 1, sha256: 'a'.repeat(64) },
      package: { name: '@fixture/guest', version: '1.0.0' },
    };
    assert.doesNotThrow(Reflect.construct.bind(Reflect, Reader, [input]));
    for (const version of ['latest', 'git:revision', 'workspace:*', 'v1.0.0'])
      assert.throws(
        Reflect.construct.bind(Reflect, Reader, [
          { ...input, package: { ...input.package, version } },
        ]),
      );
    assert.throws(
      Reflect.construct.bind(Reflect, Reader, [{ ...input, directory: '/tmp/../tmp' }]),
    );
  }
  private requirements(): { interpreter: string; requiredLibraries: string[] } {
    return {
      interpreter: '/lib64/ld-linux-x86-64.so.2',
      requiredLibraries: [...Fixture.libraries],
    };
  }
}
const suite = new GuestRuntimeUnit();
test(
  'unit: guest ELF verifier admits the qualified real GNU toolchain executable',
  suite.positive.bind(suite),
);
test(
  'unit: guest ELF verifier rejects foreign architecture and malformed headers',
  suite.headers.bind(suite),
);
test(
  'unit: guest ELF verifier binds interpreter and the complete declared library set',
  suite.dependencies.bind(suite),
);
test(
  'unit: guest ELF verifier rejects unsafe header offsets and excessive segment counts',
  suite.bounds.bind(suite),
);

test(
  'unit: guest ELF interpreter comparison cannot mask high-bit path bytes',
  suite.strings.bind(suite),
);

test(
  'unit: guest archive configuration rejects mutable package versions and noncanonical custody paths',
  suite.configuration.bind(suite),
);

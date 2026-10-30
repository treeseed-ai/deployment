import assert from 'node:assert/strict';
import { test } from 'bun:test';
import * as Sandbox from '@treeseed-cordis/deployment/sandbox';

interface ImageProjection {
  parse(
    table: unknown,
    reference: unknown,
  ): Readonly<{
    reference: string;
    manifestDigest: string;
    mediaType: string;
  }>;
}
class NativeImageTargetCases {
  static readonly digest = 'sha256:' + 'a'.repeat(64);
  static readonly reference = 'registry.example/fixture/native@' + this.digest;
  static readonly oci = 'application/vnd.oci.image.manifest.v1+json';
  static readonly docker = 'application/vnd.docker.distribution.manifest.v2+json';
  static readonly header = 'REF TYPE DIGEST SIZE PLATFORMS LABELS\n';
  static readonly row =
    this.reference + ' ' + this.oci + ' ' + this.digest + ' 1.2 MiB linux/amd64 -\n';
  private projection(): ImageProjection {
    const Type = Reflect.get(Sandbox, 'NativeImageTargetProjection');
    assert.equal(typeof Type, 'function', 'Public native image target projection missing');
    return new Type() as ImageProjection;
  }
  accepted(table: string, mediaType: string): void {
    const result = this.projection().parse(table, NativeImageTargetCases.reference);
    assert.deepEqual(result, {
      reference: NativeImageTargetCases.reference,
      manifestDigest: NativeImageTargetCases.digest,
      mediaType,
    });
    assert(Object.isFrozen(result));
  }
  rejected(table: unknown, reference: unknown): void {
    const projection = this.projection();
    assert.throws(projection.parse.bind(projection, table, reference), this.safe.bind(this));
  }
  private safe(error: unknown): boolean {
    assert(error instanceof Error);
    assert.equal(error.message, 'KATA_IMAGE_TARGET_INVALID');
    assert.equal(Reflect.get(error, 'cause'), undefined);
    assert(!String(error).includes('PRIVATE_'));
    return true;
  }
}
const suite = new NativeImageTargetCases();
const cases = NativeImageTargetCases;
for (const type of [cases.oci, cases.docker])
  test(
    'unit: native image target binds exact manifest edge ' + type,
    suite.accepted.bind(suite, cases.header + cases.row.replace(cases.oci, type), type),
  );
test(
  'unit: native image target permits unrelated shared images without admitting them',
  suite.accepted.bind(
    suite,
    cases.header + 'other:mutable unsupported sha256:other 1 B - -\n' + cases.row,
    cases.oci,
  ),
);
for (const table of [
  null,
  '',
  cases.header,
  cases.row,
  'REF DIGEST TYPE SIZE PLATFORMS LABELS\n' + cases.row,
  cases.header + cases.row + cases.row,
  cases.header + cases.row.replace(cases.reference, 'PRIVATE_FOREIGN@' + cases.digest),
  cases.header + cases.row.replace(' ' + cases.digest, ' sha256:' + 'b'.repeat(64)),
  cases.header + cases.row.replace(cases.oci, 'application/vnd.oci.image.index.v1+json'),
  cases.header +
    cases.row.replace(cases.oci, 'application/vnd.docker.distribution.manifest.list.v2+json'),
  cases.header + cases.row.replace(cases.oci, 'PRIVATE_UNSUPPORTED'),
  cases.header + cases.reference + '\n',
  cases.header + cases.reference + ' ' + cases.oci + ' ' + cases.digest + '\n',
  cases.header + cases.row + '\0PRIVATE_INPUT',
  'x'.repeat(1048577),
  cases.header + cases.row + 'other\n'.repeat(16384),
])
  test(
    'unit: native image target refuses uncertain edge ' + JSON.stringify(table).slice(0, 150),
    suite.rejected.bind(suite, table, cases.reference),
  );
for (const reference of [
  null,
  '',
  'PRIVATE_MUTABLE:latest',
  'fixture@sha256:short',
  cases.reference + '\0',
])
  test(
    'unit: native image target rejects invalid reference ' + JSON.stringify(reference),
    suite.rejected.bind(suite, cases.header + cases.row, reference),
  );

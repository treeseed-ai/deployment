import assert from 'node:assert/strict';
import { test } from 'bun:test';
import * as Configuration from '../../src/kata-configuration.js';
import { ConfigurationFixture } from '../support/runtime-configuration-program.js';
interface Projection {
  parse(text: string, proof: unknown): Record<string, unknown>;
}
class ConfigurationProjectionTests {
  private projection(): Projection {
    const Type = Reflect.get(Configuration, 'RuntimeConfigurationProjection');
    assert.equal(typeof Type, 'function', 'Production configuration projection missing');
    return new Type() as Projection;
  }
  private proof(): object {
    const components = [];
    for (const [role, path] of [
      ['configuration', 'config/runtime.toml'],
      ['hypervisor', 'bin/qemu'],
      ['kernel', 'kernel'],
      ['rootfs', 'rootfs'],
      ['virtiofs', 'bin/virtiofs'],
    ])
      components.push({
        role,
        member: {
          requestedPath: 'opt/kata/' + path,
          path: 'opt/kata/' + path,
          sha256: 'a'.repeat(64),
          size: 1,
          mode: 0o644,
          links: [],
        },
      });
    return { formatVersion: 1, archive: { sha256: 'b'.repeat(64), size: 4 }, components };
  }
  rejected(field: string, value: string): void {
    const projection = this.projection();
    const text = ConfigurationFixture.text.replace(
      new RegExp('^' + field + ' = .+$', 'm'),
      field + ' = ' + value,
    );
    assert.throws(projection.parse.bind(projection, text, this.proof()), {
      message: 'KATA_CONFIGURATION_INVALID',
    });
  }
  snapshot(): void {
    const proof = this.proof();
    const result = this.projection().parse(ConfigurationFixture.text, proof);
    const original = JSON.stringify(result);
    Reflect.get(proof, 'archive').sha256 = 'c'.repeat(64);
    assert.equal(JSON.stringify(result), original);
    assert(Object.isFrozen(Reflect.get(result, 'archive')));
    assert(Object.isFrozen(Reflect.get(result, 'resources')));
    assert(Object.isFrozen(Reflect.get(result, 'references')));
  }
}
const suite = new ConfigurationProjectionTests();
for (const [field, value] of [
  ['default_vcpus', '0'],
  ['default_vcpus', '1.5'],
  ['default_maxvcpus', '-1'],
  ['default_memory', '0'],
  ['default_memory', '9223372036854775807'],
  ['default_maxmemory', '100'],
  ['overhead_vcpus', 'nan'],
  ['overhead_vcpus', '-0.2'],
  ['overhead_memory', '-1'],
  ['memory_slots', '0'],
  ['static_sandbox_resource_mgmt', '"true"'],
])
  test(
    'unit: configuration resources reject ' + field + '=' + value,
    suite.rejected.bind(suite, field!, value!),
  );
test(
  'unit: runtime reference proof snapshots and freezes all selected metadata',
  suite.snapshot.bind(suite),
);

import assert from 'node:assert/strict';
import { test } from 'bun:test';
import * as Hypervisor from '../../src/kata-hypervisor.js';
interface ShapeParser {
  parse(args: readonly string[]): object;
}
class VmShapeParsingTests {
  private parser(): ShapeParser {
    const Constructor = Reflect.get(Hypervisor, 'QemuStartupShape');
    assert.equal(typeof Constructor, 'function', 'Production QEMU shape parser missing');
    return new Constructor() as ShapeParser;
  }
  accepted(args: string[], expected: number[]): void {
    assert.deepEqual(this.parser().parse(args), {
      vcpus: expected[0],
      maximumVcpus: expected[1],
      memoryMiB: expected[2],
      maximumMemoryMiB: expected[3],
    });
  }
  rejected(args: string[]): void {
    assert.throws(this.parser().parse.bind(this.parser(), args), {
      message: 'SANDBOX_VM_SHAPE_UNVERIFIED',
    });
  }
}
const suite = new VmShapeParsingTests();
for (const [cpu, memory, expected] of [
  ['2', '1024', [2, 2, 1024, 1024]],
  [
    'cpus=2,maxcpus=8,sockets=2,cores=2,threads=2',
    'size=1G,slots=10,maxmem=4G',
    [2, 8, 1024, 4096],
  ],
  ['1,maxcpus=4', '1048576K,maxmem=1T', [1, 4, 1024, 1048576]],
] as const)
  test(
    'unit: QEMU startup parses bounded explicit CPU and binary memory shape ' + cpu + ' ' + memory,
    suite.accepted.bind(suite, ['-smp', cpu, '-m', memory], [...expected]),
  );
for (const args of [
  [],
  ['-smp', '2'],
  ['-smp', '2', '-m'],
  ['-smp', '2', '-smp', '2', '-m', '1G'],
  ['-smp', '2', '-m', '1G', '-m', '1G'],
])
  test(
    'unit: QEMU startup rejects ambiguous argument structure ' + JSON.stringify(args),
    suite.rejected.bind(suite, args),
  );
for (const cpu of [
  '0',
  '-1',
  '1.5',
  '2,maxcpus=1',
  '2,cpus=2',
  '2,maxcpus=3,maxcpus=4',
  '2,unknown=3',
  '2,sockets=0',
  '999999999999999999999',
])
  test(
    'unit: QEMU startup rejects unsupported CPU shape ' + cpu,
    suite.rejected.bind(suite, ['-smp', cpu, '-m', '1G']),
  );
for (const memory of [
  '0',
  '-1',
  '1.5G',
  '1023K',
  '1GB',
  '1G,maxmem=512M',
  '1G,size=1G',
  '1G,slots=0',
  '1G,unknown=2',
  '1G,maxmem=2G,maxmem=3G',
  '999999999999999999T',
])
  test(
    'unit: QEMU startup rejects unsupported memory shape ' + memory,
    suite.rejected.bind(suite, ['-smp', '2', '-m', memory]),
  );

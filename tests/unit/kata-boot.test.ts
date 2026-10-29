import assert from 'node:assert/strict';
import { test } from 'bun:test';
import * as Hypervisor from '../../src/kata-hypervisor.js';
import { BootArguments } from '../support/kata-boot-program.js';
interface BootParser {
  parse(args: readonly string[]): object;
}
class BootProjectionCases {
  private parser(): BootParser {
    const Constructor = Reflect.get(Hypervisor, 'QemuBootProjection');
    assert.equal(typeof Constructor, 'function', 'Production boot projection missing');
    return new Constructor() as BootParser;
  }
  accepted(size = '64M'): void {
    const args = this.replace('size=64M', 'size=' + size);
    const result = this.parser().parse(args);
    assert.deepEqual(result, {
      kernel: BootArguments.kernel,
      rootfs: { path: BootArguments.rootfs, size: 67108864, driver: 'nvdimm' },
      resources: { vcpus: 3, maximumVcpus: 3, memoryMiB: 1056, maximumMemoryMiB: 1056 },
    });
    assert(Object.isFrozen(result));
    assert(Object.isFrozen(Reflect.get(result, 'rootfs')));
    assert(Object.isFrozen(Reflect.get(result, 'resources')));
  }
  private replace(before: string, after: string): string[] {
    const args = [];
    for (const entry of BootArguments.fixture()) args.push(entry.replace(before, after));
    return args;
  }
  rejected(before: string, after: string): void {
    this.invalid(this.replace(before, after));
  }
  invalid(args: string[]): void {
    const parser = this.parser();
    assert.throws(parser.parse.bind(parser, args), { message: 'SANDBOX_BOOT_UNVERIFIED' });
  }
  duplicate(flag: string, value: string): void {
    this.invalid([...BootArguments.fixture(), flag, value]);
  }
  absent(flag: string): void {
    const args = BootArguments.fixture(),
      index = args.indexOf(flag);
    args.splice(index, 2);
    this.invalid(args);
  }
  oversized(): void {
    this.invalid([...BootArguments.fixture(), 'x'.repeat(1048577)]);
  }
}
const suite = new BootProjectionCases();
for (const size of ['64M', '65536K', '67108864'])
  test(
    'unit: boot projection preserves read-only linked root image and finite resources ' + size,
    suite.accepted.bind(suite, size),
  );
for (const [before, after] of [
  ['/PRIVATE_KATA_KERNEL', 'relative'],
  ['/PRIVATE_KATA_KERNEL', '/a/../PRIVATE_KATA_KERNEL'],
  ['/PRIVATE_KATA_ROOTFS', '/PRIVATE_KATA_ROOTFS\0canary'],
  ['readonly=on', 'readonly=off'],
  ['share=off', 'share=on'],
  ['prealloc=off', 'prealloc=on'],
  ['unarmed=on', 'unarmed=off'],
  ['memdev=root', 'memdev=foreign'],
  ['id=root', 'id=root,id=duplicate'],
  ['readonly=on', 'readonly=on,unexpected=canary'],
  ['size=64M', 'size=0'],
  ['size=64M', 'size=1.5G'],
  ['size=64M', 'size=999999999999999999999T'],
  ['nvdimm,memdev', 'unknown,memdev'],
  ['3,maxcpus=3', '3,maxcpus=2'],
  ['1056M,slots=1,maxmem=1056M', '1056M,maxmem=0'],
])
  test(
    'unit: boot projection rejects invalid supported boot field ' + before + ':' + after,
    suite.rejected.bind(suite, before!, after!),
  );
for (const [flag, value] of [
  ['-kernel', '/PRIVATE_OTHER_KERNEL'],
  ['-initrd', '/PRIVATE_INITRD'],
  ['-bios', '/PRIVATE_BIOS'],
  ['-pflash', '/PRIVATE_FLASH'],
  ['-readconfig', '/PRIVATE_CONFIG'],
  ['-device', 'nvdimm,memdev=root,unarmed=on'],
  [
    '-object',
    'memory-backend-file,id=root,mem-path=/PRIVATE_OTHER,size=64M,share=off,prealloc=off,readonly=on',
  ],
])
  test(
    'unit: boot projection rejects duplicate or alternative boot flag ' + flag,
    suite.duplicate.bind(suite, flag!, value!),
  );
for (const flag of ['-kernel', '-object', '-device', '-smp', '-m'])
  test(
    'unit: boot projection requires explicit boot input ' + flag,
    suite.absent.bind(suite, flag),
  );
test('unit: boot projection rejects oversized command input', suite.oversized.bind(suite));

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { KataResourcePolicy } from '../../src/kata-resources.js';
class KataResourcesTests {
  private readonly shape = { vcpus: 2, memoryMiB: 1024, scratchMiB: 64 };
  private readonly guestText =
    '200000 100000\n1073741824\ntmpfs 4096 16384\ntmpfs 4096 16384\ntmpfs 4096 65536\nro,relatime\nro,nosuid,nodev,noexec,relatime cgroup2';
  private readonly expectedMounts = [
    'type=tmpfs,src=tmpfs,dst=/tmp,options=size=67108864:mode=1777:nosuid:nodev',
    'type=tmpfs,src=tmpfs,dst=/run,options=size=67108864:mode=0755:nosuid:nodev',
    'type=tmpfs,src=tmpfs,dst=/opt,options=size=268435456:mode=0755:nosuid:nodev',
    'type=cgroup,src=cgroup,dst=/sys/fs/cgroup,options=ro:nosuid:noexec:nodev',
  ];
  arguments(): void {
    const input = { ...this.shape };
    const policy = new KataResourcePolicy(input);
    input.vcpus = 9;
    const args = policy.arguments();
    assert.deepEqual(args.slice(0, 5), [
      '--cpus',
      '2',
      '--memory-limit',
      '1073741824',
      '--read-only',
    ]);
    assert.equal(args.filter(KataResourcesTests.mountFlag).length, 4);
    for (const expected of this.expectedMounts) assert(args.includes(expected));
    args.push('foreign');
    assert(!policy.arguments().includes('foreign'));
  }
  private static mountFlag(value: string): boolean {
    return value === '--mount';
  }
  guest(): void {
    const policy = new KataResourcePolicy(this.shape);
    assert.deepEqual(policy.assertGuest(this.guestText), this.shape);
    for (const bytes of [
      this.guestText.replace('200000', 'max'),
      this.guestText.replace('1073741824', 'max'),
      this.guestText.replace('16384', '16385'),
      this.guestText.replace('ro,', 'rw,'),
      this.guestText.replace('noexec,', ''),
      this.guestText.replace('cgroup2', 'cgroup'),
      this.guestText + '\nprivate-canary',
    ])
      assert.throws(policy.assertGuest.bind(policy, bytes), {
        code: 'KATA_RESOURCE_SHAPE_MISMATCH',
      });
  }
  private mounts() {
    const rows = [
      { destination: '/tmp', size: 67108864, mode: '1777' },
      { destination: '/run', size: 67108864, mode: '0755' },
      { destination: '/opt', size: 268435456, mode: '0755' },
    ];
    return [
      ...rows.map(KataResourcesTests.mount),
      {
        destination: '/sys/fs/cgroup',
        type: 'cgroup',
        source: 'cgroup',
        options: ['ro', 'nosuid', 'noexec', 'nodev'],
      },
    ];
  }
  private static mount(row: { destination: string; size: number; mode: string }) {
    return {
      destination: row.destination,
      type: 'tmpfs',
      source: 'tmpfs',
      options: ['size=' + row.size, 'mode=' + row.mode, 'nosuid', 'nodev'],
    };
  }
  private readonly specData = {
    root: { readonly: true },
    linux: {
      resources: { cpu: { quota: 200000, period: 100000 }, memory: { limit: 1073741824 } },
    },
    mounts: this.mounts(),
  };
  spec(): void {
    const policy = new KataResourcePolicy(this.shape);
    const spec = this.specData;
    policy.assertSpec(spec);
    for (const wrong of [
      { ...spec, root: { readonly: false } },
      { ...spec, mounts: [] },
      { ...spec, mounts: [...spec.mounts, spec.mounts[0]] },
      {
        ...spec,
        linux: {
          resources: { cpu: { quota: 200001, period: 100000 }, memory: { limit: 1073741824 } },
        },
      },
    ])
      assert.throws(policy.assertSpec.bind(policy, wrong), {
        code: 'KATA_RESOURCE_SHAPE_MISMATCH',
      });
  }
  invalid(): void {
    for (const value of [
      null,
      {},
      { ...this.shape, scratchMiB: -1 },
      { ...this.shape, vcpus: 0.5 },
      { ...this.shape, memoryMiB: Infinity },
      { ...this.shape, path: '/host' },
    ])
      assert.throws(KataResourcesTests.construct.bind(KataResourcesTests, value), {
        code: 'KATA_CONFIGURATION_INVALID',
      });
  }
  private static construct(value: unknown): void {
    new KataResourcePolicy(value);
  }
}
const suite = new KataResourcesTests();
test(
  'unit: resource arguments are bounded fixed guest mounts and snapshot caller input',
  suite.arguments.bind(suite),
);
test(
  'unit: actual guest shape requires exact CPU memory scratch and read-only evidence',
  suite.guest.bind(suite),
);
test(
  'unit: saved OCI resource shape rejects changed limits mounts duplicates and writable root',
  suite.spec.bind(suite),
);
test(
  'unit: resource shape rejects arbitrary host paths and unbounded numbers',
  suite.invalid.bind(suite),
);

import { z } from 'zod';
import { PoolSchemas, type PoolResourceShape } from '@treeseed-cordis/sdk';
import { KataSandboxError } from './kata-command.js';
/** Pure positive host policy; no runtime ownership or worker-selectable mount interface. */
export class KataResourcePolicy {
  static readonly schema = PoolSchemas.resources;
  static readonly inspection =
    'cat /sys/fs/cgroup/cpu.max; cat /sys/fs/cgroup/memory.max; stat -f -c "%T %S %b" /tmp /run /opt; awk \'$5 == "/" { print $6 }\' /proc/self/mountinfo; awk \'$5 == "/sys/fs/cgroup" { print $6 " " $(NF-2) }\' /proc/self/mountinfo';
  private static readonly cgroup = {
    destination: '/sys/fs/cgroup',
    type: 'cgroup',
    source: 'cgroup',
    options: ['ro', 'nosuid', 'noexec', 'nodev'],
  };
  private static readonly spec = z.object({
    root: z.object({ readonly: z.literal(true) }),
    linux: z.object({
      resources: z.object({
        cpu: z.object({ quota: z.number().int().positive(), period: z.number().int().positive() }),
        memory: z.object({ limit: z.number().int().positive() }),
      }),
    }),
    mounts: z.array(
      z.object({
        destination: z.string(),
        type: z.string().optional(),
        source: z.string().optional(),
        options: z.array(z.string()).optional(),
      }),
    ),
  });
  private readonly shape: PoolResourceShape;
  constructor(value: unknown) {
    const result = KataResourcePolicy.schema.safeParse(value);
    KataSandboxError.require(result.success, 'KATA_CONFIGURATION_INVALID');
    this.shape = result.data;
  }
  arguments(): string[] {
    const args = [
      '--cpus',
      String(this.shape.vcpus),
      '--memory-limit',
      String(this.shape.memoryMiB * 1048576),
      '--read-only',
    ];
    for (const mount of this.mounts())
      args.push(
        '--mount',
        'type=' +
          mount.type +
          ',src=' +
          mount.source +
          ',dst=' +
          mount.destination +
          ',options=' +
          mount.options.join(':'),
      );
    return args;
  }
  private mounts() {
    return [
      this.mount('/tmp', this.shape.scratchMiB, '1777'),
      this.mount('/run', 64, '0755'),
      this.mount('/opt', 256, '0755'),
      KataResourcePolicy.cgroup,
    ];
  }
  private mount(destination: string, sizeMiB: number, mode: string) {
    return {
      destination,
      type: 'tmpfs',
      source: 'tmpfs',
      options: ['size=' + sizeMiB * 1048576, 'mode=' + mode, 'nosuid', 'nodev'],
    };
  }
  assertSpec(value: unknown): void {
    const result = KataResourcePolicy.spec.safeParse(value);
    this.require(result.success);
    const resources = result.data.linux.resources;
    this.require(resources.cpu.quota / resources.cpu.period === this.shape.vcpus);
    this.require(resources.memory.limit === this.shape.memoryMiB * 1048576);
    for (const expected of this.mounts()) {
      const rows = result.data.mounts.filter(
        KataResourcePolicy.destination.bind(KataResourcePolicy, expected.destination),
      );
      this.require(rows.length === 1);
      const row = rows[0]!;
      this.require(row.type === expected.type && row.source === expected.source);
      this.require(
        JSON.stringify([...(row.options ?? [])].sort()) ===
          JSON.stringify([...expected.options].sort()),
      );
    }
  }
  private static destination(expected: string, row: { destination: string }): boolean {
    return row.destination === expected;
  }
  assertGuest(text: string): PoolResourceShape {
    const rows = text.trim().split('\n');
    this.require(rows.length === 7 && /^[0-9]+ [0-9]+$/.test(rows[0]!));
    const [quota, period] = rows[0]!.split(' ').map(Number);
    this.require(period! > 0 && quota! / period! === this.shape.vcpus);
    this.require(rows[1] === String(this.shape.memoryMiB * 1048576));
    this.filesystem(rows[2]!, this.shape.scratchMiB);
    this.filesystem(rows[3]!, 64);
    this.filesystem(rows[4]!, 256);
    this.require(rows[5]!.split(',').includes('ro') && !rows[5]!.split(',').includes('rw'));
    this.controllers(rows[6]!);
    return { ...this.shape };
  }
  private controllers(row: string): void {
    const [options, filesystem, extra] = row.split(' ');
    this.require(filesystem === 'cgroup2' && extra === undefined && options !== undefined);
    const flags = options.split(',');
    for (const flag of KataResourcePolicy.cgroup.options) this.require(flags.includes(flag));
    this.require(!flags.includes('rw'));
  }
  private filesystem(row: string, sizeMiB: number): void {
    this.require(/^tmpfs [0-9]+ [0-9]+$/.test(row));
    const [, block, count] = row.split(' ');
    this.require(Number(block) * Number(count) === sizeMiB * 1048576);
  }
  private require(value: unknown): asserts value {
    KataSandboxError.require(value, 'KATA_RESOURCE_SHAPE_MISMATCH');
  }
}

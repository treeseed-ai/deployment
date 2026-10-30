import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'bun:test';
import * as Sandbox from '@treeseed-cordis/deployment/sandbox';

interface FilesystemProjection {
  parse(qemu: unknown, daemon: unknown, name: unknown): object;
  connection(table: unknown, targets: unknown, path: unknown): object;
}
class NativeFilesystemCases {
  static readonly name = 'cordis-sandbox-' + 'a'.repeat(24) + '-' + 'b'.repeat(24);
  static readonly path = '/run/kata/' + this.name + '/root/virtiofsd.sock';
  static readonly shared = '/run/kata-containers/shared/sandboxes/' + this.name + '/ro';
  static readonly character = 'socket,id=virtiofsd-chardev,path=' + this.path;
  static readonly device =
    'vhost-user-fs-pci,chardev=virtiofsd-chardev,tag=kataShared,queue-size=1024';
  static readonly qemu = ['qemu', '-chardev', this.character, '-device', this.device];
  static readonly daemon = [
    'virtiofsd',
    '--socket-path',
    this.path,
    '--shared-dir',
    this.shared,
    '--cache',
    'auto',
    '--thread-pool-size=1',
    '-o',
    'announce_submounts',
  ];
  static readonly header = 'Num       RefCount Protocol Flags    Type St Inode Path\n';
  static readonly connected =
    '0000000000000000: 00000003 00000000 00000000 0001 03 4321 ' + this.path + '\n';
  static readonly listener =
    '0000000000000000: 00000002 00000000 00010000 0001 01 4320 ' + this.path + '\n';
  static readonly targets = ['pipe:[100]', 'socket:[4321]'];
  private projection(): FilesystemProjection {
    const Type = Reflect.get(Sandbox, 'NativeFilesystemProjection');
    assert.equal(typeof Type, 'function', 'Public native filesystem projection missing');
    return new Type() as FilesystemProjection;
  }
  accepted(qemu: readonly string[], daemon: readonly string[]): void {
    const result = this.projection().parse(qemu, daemon, NativeFilesystemCases.name);
    assert.deepEqual(result, {
      socketPath: NativeFilesystemCases.path,
      sharedDirectory: NativeFilesystemCases.shared,
    });
    assert(Object.isFrozen(result));
  }
  rejected(qemu: unknown, daemon: unknown, name: unknown): void {
    const projection = this.projection();
    assert.throws(projection.parse.bind(projection, qemu, daemon, name), this.safe.bind(this));
  }
  connected(table: string, targets: string[]): void {
    const result = this.projection().connection(table, targets, NativeFilesystemCases.path);
    assert.deepEqual(result, {
      inode: '4321',
      pathDigest: createHash('sha256').update(NativeFilesystemCases.path).digest('hex'),
      state: 'connected',
    });
    assert(Object.isFrozen(result));
  }
  disconnected(table: unknown, targets: unknown, path: unknown): void {
    const projection = this.projection();
    assert.throws(
      projection.connection.bind(projection, table, targets, path),
      this.safe.bind(this),
    );
  }
  private safe(error: unknown): boolean {
    assert(error instanceof Error);
    assert.equal(error.message, 'KATA_FILESYSTEM_ARGUMENTS_INVALID');
    assert.equal(Reflect.get(error, 'cause'), undefined);
    assert(!String(error).includes('PRIVATE_'));
    return true;
  }
}
const suite = new NativeFilesystemCases();
const cases = NativeFilesystemCases;
for (const qemu of [
  cases.qemu,
  ['qemu', '-chardev', 'socket,id=console,path=/PRIVATE_CONSOLE', ...cases.qemu.slice(1)],
])
  test(
    'unit: native filesystem projects pinned QEMU edge ' + qemu.length,
    suite.accepted.bind(suite, qemu, cases.daemon),
  );
for (const qemu of [
  null,
  [],
  ['qemu'],
  cases.qemu.slice(0, 3),
  [...cases.qemu, '-chardev', cases.character],
  [...cases.qemu, '-device', cases.device],
  [
    'qemu',
    '-chardev',
    cases.character.replace(cases.path, '/PRIVATE_OTHER'),
    '-device',
    cases.device,
  ],
  ['qemu', '-chardev', cases.character + ',server=on', '-device', cases.device],
  ['qemu', '-chardev', cases.character.replace('socket,', 'null,'), '-device', cases.device],
  ['qemu', '-chardev', cases.character + ',id=virtiofsd-chardev', '-device', cases.device],
  [
    'qemu',
    '-chardev',
    cases.character,
    '-device',
    cases.device.replace('kataShared', 'PRIVATE_TAG'),
  ],
  ['qemu', '-chardev', cases.character, '-device', cases.device.replace('1024', '0')],
  ['qemu', '-chardev', cases.character, '-device', cases.device + ',tag=kataShared'],
  ['qemu', '-chardev', cases.character, '-device', cases.device.replace('-pci', '-ccw')],
  [...cases.qemu, '-device', 'virtio-9p-pci,fsdev=PRIVATE_OTHER'],
  [...cases.qemu, '-fsdev', 'local,id=PRIVATE_OTHER'],
  [...cases.qemu, '-virtfs', 'local,path=/PRIVATE_OTHER'],
  [...cases.qemu, '-chardev=PRIVATE_OTHER'],
  [...cases.qemu, '--device', cases.device],
  [...cases.qemu, 'PRIVATE_\0'],
  [...cases.qemu, 7],
  [...cases.qemu, 'x'.repeat(4097)],
  new Array(8193).fill('x'),
])
  test(
    'unit: native filesystem rejects unbound QEMU selection ' + JSON.stringify(qemu).slice(0, 180),
    suite.rejected.bind(suite, qemu, cases.daemon, cases.name),
  );
for (const daemon of [
  null,
  [],
  ['virtiofsd'],
  cases.daemon.slice(0, 3),
  [...cases.daemon, '--socket-path', cases.path],
  [...cases.daemon, '--shared-dir', cases.shared],
  [...cases.daemon, '--socket-path=/PRIVATE_OTHER'],
  [...cases.daemon, '--shared-dir=/PRIVATE_OTHER'],
  [...cases.daemon, '--socket', cases.path],
  [...cases.daemon, '--fd', '9'],
  [...cases.daemon, '--sandbox=none'],
  [...cases.daemon, '-o', 'announce_submounts'],
  [...cases.daemon, 'PRIVATE_\0'],
  [...cases.daemon, 8],
  ['virtiofsd', '--socket-path', '/PRIVATE_OTHER', ...cases.daemon.slice(3)],
  ['virtiofsd', ...cases.daemon.slice(1, 4), '/PRIVATE_OTHER', ...cases.daemon.slice(5)],
])
  test(
    'unit: native filesystem rejects unbound daemon selection ' +
      JSON.stringify(daemon).slice(0, 180),
    suite.rejected.bind(suite, cases.qemu, daemon, cases.name),
  );
for (const name of [null, '', 'PRIVATE_NAME', cases.name.toUpperCase()])
  test(
    'unit: native filesystem rejects foreign resource name ' + JSON.stringify(name),
    suite.rejected.bind(suite, cases.qemu, cases.daemon, name),
  );
for (const table of [
  cases.header + cases.connected,
  cases.header + cases.listener + cases.connected,
])
  test(
    'unit: native filesystem correlates actual connected descriptor ' + table.length,
    suite.connected.bind(suite, table, cases.targets),
  );
for (const [table, targets, path] of [
  [null, cases.targets, cases.path],
  ['', cases.targets, cases.path],
  [cases.header + cases.listener, cases.targets, cases.path],
  [cases.header + cases.connected, [], cases.path],
  [cases.header + cases.connected, ['socket:[9999]'], cases.path],
  [cases.header + cases.connected + cases.connected, cases.targets, cases.path],
  [cases.header + cases.connected.replace('0001 03', '0002 03'), cases.targets, cases.path],
  [cases.header + cases.connected.replace('0001 03', '0001 01'), cases.targets, cases.path],
  [cases.header + cases.connected.replace('03 4321', '03 0'), cases.targets, cases.path],
  [cases.header + cases.connected, cases.targets, '/PRIVATE_SOCKET'],
  [cases.header + cases.connected + 'PRIVATE_\0', cases.targets, cases.path],
  [cases.header + cases.connected, [4], cases.path],
  ['x'.repeat(1048577), cases.targets, cases.path],
])
  test(
    'unit: native filesystem refuses uncertain socket state ' +
      JSON.stringify([table, targets, path]).slice(0, 180),
    suite.disconnected.bind(suite, table, targets, path),
  );

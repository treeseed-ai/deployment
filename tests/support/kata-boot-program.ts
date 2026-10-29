import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { CanonicalJson } from '@treeseed-cordis/sdk';
import * as Sandbox from '@treeseed-cordis/deployment/sandbox';

interface ProcessIdentity {
  pid: number;
  startTime: string;
  executableDigest: string;
  commandDigest: string;
}
interface BootObservation {
  readonly kind: 'kata-boot-observation';
  readonly formatVersion: 1;
  readonly process: ProcessIdentity;
  readonly boot: {
    readonly kernel: string;
    readonly rootfs: { readonly path: string; readonly size: number; readonly driver: 'nvdimm' };
    readonly resources: {
      readonly vcpus: number;
      readonly maximumVcpus: number;
      readonly memoryMiB: number;
      readonly maximumMemoryMiB: number;
    };
  };
  readonly digest: string;
}
interface Observer {
  observe(name: string): ProcessIdentity;
  boot(expected: ProcessIdentity): BootObservation;
}
interface ObserverConstructor {
  new (executable: { path: string; sha256: string }, uid: number): Observer;
}
export class BootArguments {
  static readonly kernel = '/PRIVATE_KATA_KERNEL';
  static readonly rootfs = '/PRIVATE_KATA_ROOTFS';
  static fixture(): string[] {
    return [
      '-kernel',
      this.kernel,
      '-smp',
      '3,maxcpus=3',
      '-m',
      '1056M,slots=1,maxmem=1056M',
      '-object',
      'memory-backend-file,id=root,mem-path=' +
        this.rootfs +
        ',size=64M,share=off,prealloc=off,readonly=on',
      '-device',
      'nvdimm,memdev=root,unarmed=on',
    ];
  }
}
/** Harmless Node process fixture: never a QEMU executable or Kata qualification. */
export class BootProcessFixture {
  private child: ChildProcess | null = null;
  private readonly name = 'fixture-' + randomUUID();
  observer: Observer | null = null;
  identity: ProcessIdentity | null = null;
  static type(): ObserverConstructor {
    const Constructor = Reflect.get(Sandbox, 'SandboxProcessObserver') as ObserverConstructor;
    assert.equal(typeof Constructor, 'function', 'Public process boot observer missing');
    assert.equal(typeof Constructor.prototype.boot, 'function', 'Public boot observation missing');
    return Constructor;
  }
  async prepare(args = BootArguments.fixture()): Promise<void> {
    const Constructor = BootProcessFixture.type();
    const program = resolve('dist/tests/support/kata-boot-program.js');
    this.child = spawn('node', [program, '--fixture', '-name', 'sandbox-' + this.name, ...args], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    await once(this.child, 'message', { signal: AbortSignal.timeout(5000) });
    const path = readlinkSync('/proc/' + this.child.pid + '/exe');
    const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
    this.observer = new Constructor({ path, sha256 }, process.getuid!());
    this.identity = this.observer.observe(this.name);
  }
  read(identity = this.identity!): BootObservation {
    assert(this.observer && identity);
    return this.observer.boot(identity);
  }
  async close(): Promise<void> {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    const ended = once(this.child, 'close', { signal: AbortSignal.timeout(5000) });
    this.child.kill('SIGKILL');
    await ended;
  }
}
class BootObserverProgram {
  static async run(): Promise<void> {
    const fixture = new BootProcessFixture();
    try {
      await fixture.prepare();
      this.verify(fixture);
    } finally {
      await fixture.close();
    }
    process.stdout.write('generation-bound-boot-public-ok\n');
  }
  private static verify(fixture: BootProcessFixture): void {
    const first = fixture.read(),
      { digest, ...payload } = first;
    assert.equal(payload.kind, 'kata-boot-observation');
    assert.equal(payload.formatVersion, 1);
    assert.deepEqual(payload.process, fixture.identity);
    this.inputs(payload.boot);
    assert.equal(digest, CanonicalJson.digest(payload));
    assert(Object.isFrozen(first) && Object.isFrozen(payload.process));
    assert.deepEqual(fixture.read(), first);
  }
  private static inputs(boot: BootObservation['boot']): void {
    assert.equal(boot.kernel, BootArguments.kernel);
    assert.deepEqual(boot.rootfs, {
      path: BootArguments.rootfs,
      size: 67108864,
      driver: 'nvdimm',
    });
    assert.deepEqual(boot.resources, {
      vcpus: 3,
      maximumVcpus: 3,
      memoryMiB: 1056,
      maximumMemoryMiB: 1056,
    });
    assert(Object.isFrozen(boot) && Object.isFrozen(boot.rootfs));
    assert(Object.isFrozen(boot.resources));
  }
  static fixture(): void {
    process.send!('ready');
    setInterval(this.tick, 1000);
  }
  private static tick(): void {}
  static async main(): Promise<void> {
    if (process.argv[2] === '--fixture') this.fixture();
    else await this.run();
  }
}
if (import.meta.main) await BootObserverProgram.main();

import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpathSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SandboxProcessObserver, type SandboxProcessIdentity } from '../../src/kata-hypervisor.js';
interface StartupShape {
  vcpus: number;
  maximumVcpus: number;
  memoryMiB: number;
  maximumMemoryMiB: number;
}
interface StartupObserver {
  startup(identity: SandboxProcessIdentity): StartupShape;
}
/** Genuine Linux argument-carrier process only; this never represents a VM or starts one. */
class VmArgumentPeer {
  private readonly controller = new AbortController();
  async run(): Promise<void> {
    process.once('SIGTERM', this.cancel.bind(this));
    process.stdout.write('vm-argument-peer-ready\n');
    try {
      await delay(10000, undefined, { signal: this.controller.signal });
    } catch (error) {
      if (!this.controller.signal.aborted) throw error;
    }
  }
  private cancel(): void {
    this.controller.abort();
  }
}
class VmObserverFixture {
  readonly name = 'vm-fixture-' + randomUUID();
  private child: ChildProcessWithoutNullStreams | null = null;
  readonly binary = realpathSync(process.execPath);
  readonly observer = new SandboxProcessObserver(
    {
      path: this.binary,
      sha256: createHash('sha256').update(readFileSync(this.binary)).digest('hex'),
    },
    process.getuid!(),
  );
  async start(mode: string): Promise<void> {
    this.child = spawn(
      process.execPath,
      [
        resolve('dist/tests/support/kata-vm-shape-program.js'),
        '--peer',
        '-name',
        'sandbox-' + this.name,
        ...this.arguments(mode),
      ],
      {
        env: { PATH: process.env.PATH ?? '', LANG: 'C' },
        timeout: 10000,
      },
    );
    const [bytes] = await once(this.child.stdout, 'data');
    assert.equal(bytes.toString(), 'vm-argument-peer-ready\n');
  }
  private arguments(mode: string): string[] {
    const args = [
      '-smp',
      '2,maxcpus=8',
      '-m',
      '1G,slots=10,maxmem=4G',
      '-append',
      'PRIVATE_VM_CANARY',
    ];
    if (mode === 'missing') return ['-append', 'PRIVATE_VM_CANARY'];
    if (mode === 'duplicate') args.push('-m', '1G');
    if (mode === 'malformed') args[1] = '2,maxcpus=1';
    if (mode === 'overflow') args[3] = '999999999999999999999999T';
    return args;
  }
  async close(): Promise<void> {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    const closed = once(this.child, 'close');
    this.child.kill('SIGTERM');
    await closed;
  }
}
class VmStartupProgram {
  async run(): Promise<void> {
    const mode = process.argv[2] ?? 'normal';
    const fixture = new VmObserverFixture();
    try {
      await fixture.start(mode);
      this.observe(fixture, mode);
    } finally {
      await fixture.close();
    }
    process.stdout.write('vm-startup-' + mode + '-ok\n');
  }
  private observe(fixture: VmObserverFixture, mode: string): void {
    const observer = fixture.observer as SandboxProcessObserver & StartupObserver;
    assert.equal(typeof observer.startup, 'function', 'Production VM startup observer missing');
    const identity = observer.observe(fixture.name);
    if (mode === 'identity') identity.commandDigest = '0'.repeat(64);
    if (mode === 'generation') identity.startTime += '0';
    if (mode !== 'normal')
      return assert.throws(observer.startup.bind(observer, identity), this.safe.bind(this));
    assert.deepEqual(observer.startup(identity), {
      vcpus: 2,
      maximumVcpus: 8,
      memoryMiB: 1024,
      maximumMemoryMiB: 4096,
    });
    assert.deepEqual(observer.startup(identity), observer.startup(identity));
  }
  private safe(error: unknown): boolean {
    assert(error instanceof Error);
    assert.equal(error.message, 'SANDBOX_VM_SHAPE_UNVERIFIED');
    assert(!error.message.includes('PRIVATE_VM_CANARY'));
    return true;
  }
}
if (import.meta.main) {
  if (process.argv[2] === '--peer') await new VmArgumentPeer().run();
  else await new VmStartupProgram().run();
}

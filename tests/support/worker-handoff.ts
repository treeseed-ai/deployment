import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ServicePlan } from '@treeseed-cordis/sdk';
import { WorkerBootstrap } from '../../src/service-bootstrap.js';
import { ServiceWorkerOwnerClient } from '../../src/service-ipc.js';

/** Real compiled child and private fixture installation; never submits a container application. */
export class WorkerHandoffScenario {
  private bootstrap: WorkerBootstrap | null = null;
  private child: ChildProcess | null = null;
  private readonly owner: string;
  private readonly held: string;
  constructor(private readonly plan: ServicePlan, root: string) {
    this.owner = join(plan.configuration.installationDirectory, '.cordis/writer.lock/owner.json');
    this.held = join(root, 'held-bootstrap-owner.json');
  }
  async run(): Promise<void> {
    let failure: unknown;
    try {
      this.launch();
      await this.handoff();
      await this.ready();
    } catch (error) {
      failure = error;
      throw error;
    } finally { await this.cleanup(failure); }
  }
  private launch(): void {
    this.bootstrap = WorkerBootstrap.prepare(this.plan);
    renameSync(this.owner, this.held);
    this.child = spawn(this.bootstrap.executable, [
      '--installation', this.plan.configuration.installationDirectory,
      '--plan', this.plan.id, '--digest', this.plan.digest,
      '--nonce', this.bootstrap.nonce, '--protocol', '3',
    ], { stdio: 'ignore', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  }
  private async handoff(): Promise<void> {
    await new Promise<void>(WorkerHandoffScenario.hold);
    assert.equal(this.child!.exitCode, null, 'Worker inspected mutable state before handoff');
    assert.equal(this.child!.signalCode, null);
    this.restore();
    await this.bootstrap!.handoff(this.child!.pid!);
  }
  private restore(): void {
    if (existsSync(this.held)) renameSync(this.held, this.owner);
  }
  private async ready(): Promise<void> {
    const socket = join(this.plan.configuration.installationDirectory, '.cordis/control/worker.sock');
    const deadline = Date.now() + 20000;
    while (!existsSync(socket) && Date.now() < deadline) {
      assert.equal(this.child!.exitCode, null, 'Worker exited after handoff');
      await new Promise<void>(WorkerHandoffScenario.tick);
    }
    assert(existsSync(socket), 'Owner socket was not published');
    const owner = new ServiceWorkerOwnerClient({ installationDirectory: this.plan.configuration.installationDirectory });
    const status = await owner.status();
    assert.equal(status.installationId, this.plan.configuration.installationId);
    assert.equal(status.activeComposition, null);
  }
  private async cleanup(failure: unknown): Promise<void> {
    try {
      this.restore();
      this.bootstrap?.close();
      await this.stop();
    } catch (error) {
      if (failure !== undefined) throw new AggregateError([failure, error], 'Worker handoff and cleanup failed');
      throw error;
    }
  }
  private async stop(): Promise<void> {
    if (!this.child?.pid || this.child.exitCode !== null || this.child.signalCode !== null) return;
    const expected = statSync(this.bootstrap!.executable);
    const running = statSync('/proc/' + this.child.pid + '/exe');
    assert.equal(running.dev, expected.dev);
    assert.equal(running.ino, expected.ino);
    this.child.kill('SIGTERM');
    const deadline = Date.now() + 15000;
    while (this.child.exitCode === null && this.child.signalCode === null && Date.now() < deadline)
      await new Promise<void>(WorkerHandoffScenario.tick);
    assert(this.child.exitCode !== null || this.child.signalCode !== null, 'Worker did not stop');
  }
  private static hold(done: () => void): void { setTimeout(done, 2500); }
  private static tick(done: () => void): void { setTimeout(done, 25); }
}

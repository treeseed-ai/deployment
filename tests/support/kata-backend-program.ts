import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, chmodSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { CanonicalJson } from '@treeseed-cordis/sdk';
import * as deployment from '../../src/diagnose.js';

interface SandboxEvidence { id: string; resourceName: string; kernel: string; inspectionDigest: string; }
interface Backend {
  create(id: string, signal: AbortSignal): Promise<SandboxEvidence>;
  inspect(id: string, signal: AbortSignal): Promise<SandboxEvidence>;
  destroy(id: string, signal: AbortSignal): Promise<{ id: string; destroyed: true; inspectionDigest: string }>;
  close(): Promise<void>;
}
interface BackendConstructor { open(configuration: unknown): Promise<Backend>; }

/** Qualification-only daemon fixture; production default construction remains in Deployment. */
class PrivateKataFixture {
  readonly directory = mkdtempSync(join(process.env.RUNNER_TEMP!, 'cordis-backend-'));
  readonly socket = join(this.directory, 'containerd.sock');
  readonly namespaceScope = { installationId: 'fixture-' + randomUUID(), serviceId: 'worker', providerGeneration: 'a'.repeat(64) };
  readonly namespace = 'cordis-sandbox-' + CanonicalJson.digest(this.namespaceScope).slice(0, 24);
  private daemon: ChildProcess | null = null;
  private log: number | null = null;
  private daemonArguments: string[] = [];
  static hash(file: string): string { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
  static startTime(pid: number): string {
    const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]!;
  }
  async start(): Promise<void> {
    const config = join(this.directory, 'config.toml');
    writeFileSync(config, 'version = 2\ndisabled_plugins = ["io.containerd.grpc.v1.cri"]\n', { mode: 0o600 });
    this.daemonArguments = ['--config', config, '--root', join(this.directory, 'root'), '--state', join(this.directory, 'state'), '--address', this.socket];
    this.log = openSync(join(this.directory, 'daemon.log'), 'wx', 0o600);
    this.daemon = spawn('/usr/bin/containerd', this.daemonArguments, { stdio: ['ignore', this.log, this.log] });
    this.daemon.on('error', this.failed.bind(this));
    await this.ready();
    chmodSync(this.socket, 0o600);
  }
  private failed(error: Error): void { throw error; }
  private async ready(): Promise<void> {
    for (let count = 0; count < 200; count++) {
      assert.equal(this.daemon!.exitCode, null);
      const result = spawnSync('/usr/bin/ctr', ['--address', this.socket, 'version'], { timeout: 1000 });
      if (result.status === 0) return;
      await Bun.sleep(25);
    }
    throw new Error('private daemon readiness failed');
  }
  run(args: string[]): string {
    const result = spawnSync('/usr/bin/ctr', ['--address', this.socket, '--namespace', this.namespace, ...args], { encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  async configuration(): Promise<unknown> {
    const scope = this.namespaceScope;
    const custody = join(this.directory, 'custody');
    mkdirSync(custody, { mode: 0o700 });
    return {
      scope, custody, endpointDirectory: this.directory,
      daemon: { pid: this.daemon!.pid!, startTime: PrivateKataFixture.startTime(this.daemon!.pid!), commandDigest: PrivateKataFixture.hash('/proc/' + this.daemon!.pid + '/cmdline') },
      client: { path: realpathSync('/usr/bin/ctr'), sha256: PrivateKataFixture.hash('/usr/bin/ctr') },
      runtime: { version: '4.1.0', shim: this.file('/opt/kata/runtime-rs/bin/containerd-shim-kata-v2'), configuration: this.file(process.env.KATA_CONF_FILE!) },
      image: 'docker.io/library/busybox@sha256:66a6306db78bf2dbf3487f293aa8d6990d8e506fdffab9cc43fe422becf886e4',
    };
  }
  private file(path: string): object { return { path: realpathSync(path), sha256: PrivateKataFixture.hash(path) }; }
  async stop(): Promise<void> {
    if (this.daemon?.exitCode === null) {
      this.daemon.kill('SIGTERM');
      for (let count = 0; count < 200 && this.daemon.exitCode === null; count++) await Bun.sleep(25);
      assert.notEqual(this.daemon.exitCode, null, 'private daemon must stop');
    }
    if (this.log !== null) closeSync(this.log);
  }
}

class KataBackendProgram {
  private host(): void {
    assert.equal(process.env.GITHUB_ACTIONS, 'true');
    assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
    assert(process.env.RUNNER_TEMP?.startsWith('/home/runner/'));
    assert.equal(process.getuid?.(), 0);
  }
  async run(): Promise<void> {
    if (process.argv[2] === '--interface') return this.interface();
    this.host();
    const fixture = new PrivateKataFixture();
    const failures: unknown[] = [];
    try { await this.exercise(fixture); }
    catch (error) { failures.push(error); }
    try { await fixture.stop(); }
    catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Kata backend qualification failed');
    process.stdout.write('owned-kata-backend-ok\n');
  }
  private async interface(): Promise<void> {
    const constructor = Reflect.get(deployment, 'KataSandboxBackend') as BackendConstructor;
    assert.equal(typeof constructor, 'function', 'production Kata backend must exist');
    await assert.rejects(constructor.open({}), { message: 'KATA_CONFIGURATION_INVALID' });
    process.stdout.write('kata-interface-ok\n');
  }
  private async exercise(fixture: PrivateKataFixture): Promise<void> {
    await fixture.start();
    const configuration = await fixture.configuration();
    const constructor = Reflect.get(deployment, 'KataSandboxBackend') as BackendConstructor;
    assert.equal(typeof constructor, 'function', 'production Kata backend must exist');
    const image = Reflect.get(configuration as object, 'image') as string;
    fixture.run(['images', 'pull', '--local', '--platform', 'linux/amd64', '--snapshotter', 'native', image]);
    const backend = await constructor.open(configuration);
    try { await this.lifecycle(backend); }
    finally { await backend.close(); }
    assert.equal(fixture.run(['tasks', 'list', '--quiet']), '');
    assert.equal(fixture.run(['containers', 'list', '--quiet']), '');
  }
  private async lifecycle(backend: Backend): Promise<void> {
    const signal = new AbortController().signal;
    const id = 'sandbox-' + randomUUID();
    const created = await backend.create(id, signal);
    const inspected = await backend.inspect(id, signal);
    assert.equal(created.id, id);
    assert.equal(created.kernel, inspected.kernel);
    assert.equal(created.inspectionDigest, inspected.inspectionDigest);
    assert.equal((await backend.destroy(id, signal)).destroyed, true);
    await assert.rejects(backend.inspect(id, signal));
    await assert.rejects(backend.create(id, signal));
    await assert.rejects(backend.destroy('sandbox-' + randomUUID(), signal));
  }
}
if (import.meta.main) await new KataBackendProgram().run();

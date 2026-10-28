import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  CanonicalJson,
  type SandboxControlClient,
  type SandboxControlScope,
} from '@treeseed-cordis/sdk';
import { PrivateKataFixture } from './kata-backend-program.js';
import {
  SandboxControlApplication,
  SandboxSocketClient,
} from '@treeseed-cordis/deployment/sandbox-control';

class HostedChannelQualification {
  private readonly fixture = new PrivateKataFixture();
  private readonly endpointDirectory = join(this.fixture.directory, 'worker-control');
  private readonly authorityFile = join(this.fixture.directory, 'worker-authority.json');
  private readonly scope: SandboxControlScope = {
    ...this.fixture.namespaceScope,
    serviceGeneration: CanonicalJson.digest({ fixture: this.fixture.directory, role: 'worker' }),
  };
  private readonly credential = randomBytes(32).toString('hex');
  private application: SandboxControlApplication | null = null;
  async run(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.exercise();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.application?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.fixture.stop();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, 'Private channel qualification failed');
    assert.equal(existsSync(join(this.endpointDirectory, 'control.sock')), false);
    process.stdout.write('sandbox-channel-kata-ok\n');
  }
  private authority(credential: string): object {
    return {
      credential,
      grant: {
        schemaVersion: 'treeseed.sandbox-grant/v1',
        id: 'grant:hosted-fixture',
        revision: 1,
        scope: this.scope,
        state: 'granted',
        expiresAtEpochMs: Date.now() + 180000,
        operations: ['ready', 'create', 'inspect', 'assign', 'execute', 'destroy'],
      },
    };
  }
  private client(authorityFile = this.authorityFile, scope = this.scope): SandboxSocketClient {
    return new SandboxSocketClient({
      endpointDirectory: this.endpointDirectory,
      authorityFile,
      scope,
    });
  }
  private async host(): Promise<object> {
    await this.fixture.start();
    const host = (await this.fixture.configuration()) as object;
    const image = Reflect.get(host, 'image') as string;
    this.fixture.run([
      'images',
      'pull',
      '--local',
      '--platform',
      'linux/amd64',
      '--snapshotter',
      'native',
      image,
    ]);
    return host;
  }
  private async exercise(): Promise<void> {
    const host = await this.host();
    mkdirSync(this.endpointDirectory, { mode: 0o700 });
    writeFileSync(this.authorityFile, JSON.stringify(this.authority(this.credential)), {
      mode: 0o600,
    });
    this.application = await SandboxControlApplication.start(this.configuration(host));
    assert.match(this.application.generation, /^[a-f0-9]{64}$/);
    const client = this.client();
    assert.equal(
      (await client.ready(new AbortController().signal)).configurationDigest,
      CanonicalJson.digest(host),
    );
    await this.denials();
    await this.guest(client);
    assert.equal(this.fixture.run(['tasks', 'list', '--quiet']), '');
    assert.equal(this.fixture.run(['containers', 'list', '--quiet']), '');
  }
  private configuration(host: object): object {
    const path = realpathSync('/lib/x86_64-linux-gnu/libc.so.6');
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
    return {
      scope: this.scope,
      endpointDirectory: this.endpointDirectory,
      authorityFile: this.authorityFile,
      socketLibrary: { path, sha256: PrivateKataFixture.hash(path) },
      host,
      artifact: {
        package: metadata.name,
        version: metadata.version,
        integrity: CanonicalJson.digest(metadata),
      },
    };
  }
  private async denials(): Promise<void> {
    const signal = new AbortController().signal;
    const wrong = join(this.fixture.directory, 'wrong-authority.json');
    writeFileSync(wrong, JSON.stringify(this.authority(randomBytes(32).toString('hex'))), {
      mode: 0o600,
    });
    await assert.rejects(this.client(wrong).ready(signal), {
      message: 'SANDBOX_PROVIDER_UNAVAILABLE',
    });
    await assert.rejects(
      this.client(this.authorityFile, { ...this.scope, serviceId: 'foreign' }).ready(signal),
      { message: 'SANDBOX_SCOPE_MISMATCH' },
    );
    assert.equal(this.fixture.run(['tasks', 'list', '--quiet']), '');
    assert.equal(this.fixture.run(['containers', 'list', '--quiet']), '');
  }
  private async guest(client: SandboxControlClient): Promise<void> {
    const id = 'sandbox-' + randomUUID();
    const signal = new AbortController().signal;
    const failures: unknown[] = [];
    try {
      await this.prepared(client, id, signal);
    } catch (error) {
      failures.push(error);
    }
    try {
      assert.equal((await client.destroy(id, signal)).destroyed, true);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, 'Channel guest lifecycle failed');
    await assert.rejects(client.inspect(id, signal));
    assert(!JSON.stringify(failures).includes(this.credential));
  }
  private async prepared(
    client: SandboxControlClient,
    id: string,
    signal: AbortSignal,
  ): Promise<void> {
    assert.equal((await client.create(id, signal)).assignment, null);
    assert.equal((await client.inspect(id, signal)).assignment, null);
    const assignment = await client.assign(id, 'assignment:channel', 'environment:good', signal);
    assert.equal(assignment.environmentId, 'environment:good');
    assert.equal((await client.inspect(id, signal)).assignment?.assignmentId, 'assignment:channel');
    await assert.rejects(client.execute(id, 'verification', signal));
    const setup = await client.execute(id, 'setup', signal);
    assert.equal(setup.exitCode, 0);
    assert.deepEqual(await client.execute(id, 'setup', signal), setup);
    assert.equal((await client.execute(id, 'verification', signal)).exitCode, 0);
    const text = JSON.stringify({ assignment, setup });
    assert(!text.includes(this.fixture.directory));
    assert(!text.includes(this.credential));
    assert(!text.includes('guest-output-canary'));
    assert.equal(existsSync(join(this.fixture.directory, 'host-script-ran')), false);
    assert.equal(existsSync(join(this.fixture.directory, 'ambient-script-ran')), false);
  }
}
class SandboxChannelProgram {
  async run(): Promise<void> {
    if (process.argv[2] === '--interface') return this.interface();
    assert.equal(process.env.GITHUB_ACTIONS, 'true');
    assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
    assert(process.env.RUNNER_TEMP?.startsWith('/home/runner/'));
    assert.equal(process.getuid?.(), 0);
    await new HostedChannelQualification().run();
  }
  private async interface(): Promise<void> {
    assert.equal(typeof SandboxControlApplication, 'function');
    assert.equal(typeof SandboxSocketClient, 'function');
    await assert.rejects(SandboxControlApplication.start({}), {
      message: 'INVALID_SANDBOX_CONTROL_CONTRACT',
    });
    process.stdout.write('sandbox-channel-interface-ok\n');
  }
}
if (import.meta.main) await new SandboxChannelProgram().run();

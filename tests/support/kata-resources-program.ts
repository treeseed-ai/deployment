import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CanonicalJson } from '@treeseed-cordis/sdk';
import {
  CordisScope,
  type ProviderLease,
  type CompositionDescriptor,
} from '@treeseed-cordis/sdk/runtime';
import {
  KataSandboxPlugin,
  KataSandboxToken,
  type KataSandboxHost,
} from '@treeseed-cordis/deployment/sandbox';
import { PrivateKataFixture } from './kata-backend-program.js';
class KataResourcesProgram {
  private static readonly resources = { vcpus: 2, memoryMiB: 1024, scratchMiB: 64 };
  private static readonly image =
    'docker.io/library/ubuntu@sha256:157dc3d6e4a3e4f2c68d12df9df9ed6e808b59af6d4c3757b432b4f519916725';
  private static readonly file = { path: '/fixture/unused', sha256: 'a'.repeat(64) };
  private static readonly interfaceData = {
    scope: { installationId: 'fixture', serviceId: 'worker', providerGeneration: this.file.sha256 },
    custody: '/fixture/custody',
    endpointDirectory: '/fixture/endpoint',
    daemon: { pid: 12345, startTime: '123', commandDigest: this.file.sha256 },
    client: this.file,
    runtime: {
      version: '4.1.0',
      guestKernel: '6.18.35',
      shim: this.file,
      hypervisor: this.file,
      configuration: this.file,
    },
    image: KataResourcesProgram.image,
    resources: KataResourcesProgram.resources,
  };
  private root: CordisScope | null = null;
  private lease: ProviderLease<KataSandboxHost> | null = null;
  async run(): Promise<void> {
    if (process.argv[2] === '--interface') return this.interface();
    const fixture = new PrivateKataFixture();
    const failures: unknown[] = [];
    try {
      await this.exercise(fixture);
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.dispose();
    } catch (error) {
      failures.push(error);
    }
    try {
      await fixture.stop();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, 'Kata resource qualification failed');
    process.stdout.write('kata-resources-hosted-ok\n');
  }
  private interface(): void {
    const configuration = KataResourcesProgram.interfaceData;
    assert.equal(KataSandboxPlugin.Config.safeParse(configuration).success, true);
    for (const resources of [
      null,
      {},
      { ...KataResourcesProgram.resources, vcpus: 0 },
      { ...KataResourcesProgram.resources, mount: '/host' },
    ])
      assert.equal(
        KataSandboxPlugin.Config.safeParse({ ...configuration, resources }).success,
        false,
      );
    assert.equal(
      KataSandboxPlugin.Config.safeParse({ ...configuration, resources: undefined }).success,
      true,
    );
    process.stdout.write('kata-resources-interface-ok\n');
  }
  private async prepare(fixture: PrivateKataFixture): Promise<KataSandboxHost> {
    await fixture.start();
    const configuration = {
      ...((await fixture.configuration()) as object),
      image: KataResourcesProgram.image,
      resources: KataResourcesProgram.resources,
    };
    this.pull(fixture);
    const scopeId = 'fixture.resources:' + randomUUID();
    this.root = await CordisScope.start(this.descriptor(configuration, scopeId), {
      scopeId,
      target: 'deployment',
      principalId: 'fixture',
      resourceScope: 'fixture',
    });
    this.lease = await this.root.acquire(KataSandboxToken);
    await this.lease.value.ready();
    return this.lease.value;
  }
  private pull(fixture: PrivateKataFixture): void {
    fixture.run([
      'images',
      'pull',
      '--local',
      '--platform',
      'linux/amd64',
      '--snapshotter',
      'native',
      KataResourcesProgram.image,
    ]);
  }
  private descriptor(configuration: unknown, scopeId: string): CompositionDescriptor {
    return {
      registrations: [
        {
          token: KataSandboxToken,
          declaration: KataSandboxPlugin.declaration,
          plugin: KataSandboxPlugin,
          configuration,
          artifact: { kind: 'bundled', identity: '@treeseed-cordis/deployment' },
        },
      ],
      selections: [
        { scopeId, capability: KataSandboxToken.id, providerId: KataSandboxPlugin.declaration.id },
      ],
    };
  }
  private async exercise(fixture: PrivateKataFixture): Promise<void> {
    const host = await this.prepare(fixture);
    const id = 'sandbox-' + randomUUID();
    const signal = new AbortController().signal;
    const failures: unknown[] = [];
    try {
      await this.inspect(host, fixture, id, signal);
    } catch (error) {
      failures.push(error);
      failures.push(this.resourceEvidence(fixture, id));
    }
    try {
      await host.destroy(id, signal);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, 'Kata resource lifecycle failed');
    assert.equal(fixture.run(['tasks', 'list', '--quiet']), '');
    assert.equal(fixture.run(['containers', 'list', '--quiet']), '');
    const name = fixture.namespace + '-' + CanonicalJson.digest({ id }).slice(0, 24);
    assert(!fixture.run(['snapshots', '--snapshotter', 'native', 'list']).includes(name));
  }
  private resourceEvidence(fixture: PrivateKataFixture, id: string): Error {
    const result = spawnSync('/usr/bin/ctr', this.resourceArguments(fixture, id), {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 4096,
    });
    const safe = result.status === 0 && /^[a-zA-Z0-9_.,:/= \n-]{1,4096}$/.test(result.stdout ?? '');
    return new Error(
      JSON.stringify({
        phase: 'fixture-resource-readback',
        status: result.status,
        evidence: safe ? result.stdout.trim() : 'unavailable',
      }),
    );
  }
  private resourceArguments(fixture: PrivateKataFixture, id: string): string[] {
    const name = fixture.namespace + '-' + CanonicalJson.digest({ id }).slice(0, 24);
    const command =
      'printf "membership="; cat /proc/self/cgroup; for p in /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu/cpu.cfs_quota_us /sys/fs/cgroup/memory/memory.limit_in_bytes; do if test -r "$p"; then printf "%s=" "$p"; cat "$p"; fi; done; stat -f -c "%T %S %b" /tmp /run /opt; awk \'$5 == "/" { print "root=" $6 }\' /proc/self/mountinfo';
    return [
      '--address',
      fixture.socket,
      '--namespace',
      fixture.namespace,
      'tasks',
      'exec',
      '--exec-id',
      'resource-failure-' + randomUUID(),
      name,
      '/bin/sh',
      '-c',
      command,
    ];
  }
  private async inspect(
    host: KataSandboxHost,
    fixture: PrivateKataFixture,
    id: string,
    signal: AbortSignal,
  ): Promise<void> {
    const first = await host.create(id, signal);
    assert.deepEqual(Reflect.get(first, 'resources'), KataResourcesProgram.resources);
    assert.equal(first.assignment, null);
    const second = await host.inspect(id, signal);
    assert.deepEqual(Reflect.get(second, 'resources'), KataResourcesProgram.resources);
    this.scratchCanary(fixture, first.resourceName);
    assert.deepEqual(
      Reflect.get(await host.inspect(id, signal), 'resources'),
      KataResourcesProgram.resources,
    );
  }
  private scratchCanary(fixture: PrivateKataFixture, name: string): void {
    const command =
      'test ! -e /cordis-readonly-canary; if touch /cordis-readonly-canary 2>/dev/null; then exit 1; fi; if dd if=/dev/zero of=/tmp/cordis-scratch-canary bs=1048576 count=65 2>/dev/null; then exit 1; fi; test "$(stat -c %s /tmp/cordis-scratch-canary)" = 67108864; rm /tmp/cordis-scratch-canary';
    assert.equal(
      fixture.run([
        'tasks',
        'exec',
        '--exec-id',
        'resource-canary-' + randomUUID(),
        name,
        '/bin/sh',
        '-c',
        command,
      ]),
      '',
    );
  }
  private async dispose(): Promise<void> {
    await this.lease?.release();
    await this.root?.dispose();
  }
}
if (import.meta.main) await new KataResourcesProgram().run();

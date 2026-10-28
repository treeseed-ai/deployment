import { expect, test } from 'bun:test';
import * as deployment from '@treeseed-cordis/deployment/sandbox';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

interface Constructor {
  open(value: unknown): Promise<unknown>;
}
class KataBackendAdmissionTests {
  private readonly digest = 'a'.repeat(64);
  private readonly file = { path: '/fixture/unused', sha256: this.digest };
  private readonly configuration = {
    scope: { installationId: 'fixture', serviceId: 'worker', providerGeneration: this.digest },
    custody: '/fixture/custody',
    endpointDirectory: '/fixture/endpoint',
    daemon: { pid: 12345, startTime: '123', commandDigest: this.digest },
    client: this.file,
    runtime: {
      version: '4.1.0',
      guestKernel: '6.18.35',
      shim: this.file,
      configuration: this.file,
    },
  };
  async mutableImages(): Promise<void> {
    const backend = Reflect.get(deployment, 'KataSandboxBackend') as Constructor;
    for (const image of [
      'busybox:latest',
      'registry.example:5000/busybox:latest@sha256:' + this.digest,
    ])
      await expect(backend.open({ ...this.configuration, image })).rejects.toThrow(
        'KATA_CONFIGURATION_INVALID',
      );
  }
  declaration(): void {
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
    let selected: { classExport: string; declaration: { capability: string } } | undefined;
    for (const provider of metadata.cordisPackage.providers)
      if (provider.declaration.id === 'deployment.sandbox.kata') selected = provider;
    expect(selected?.classExport).toBe('KataSandboxPlugin');
    expect(selected?.declaration.capability).toBe('host.sandbox.kata');
  }
  async rejectsUnknown(): Promise<void> {
    const backend = Reflect.get(deployment, 'KataSandboxBackend') as Constructor;
    expect(typeof backend).toBe('function');
    for (const value of [null, {}, { image: 'busybox:latest' }, { command: 'host-script-canary' }])
      await expect(backend.open(value)).rejects.toThrow('KATA_CONFIGURATION_INVALID');
  }
  hostFixture(): void {
    const result = spawnSync(process.execPath, ['dist/tests/support/kata-backend-program.js'], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, GITHUB_ACTIONS: 'false' },
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  }
}
const suite = new KataBackendAdmissionTests();
test(
  'integration: fully shaped Kata configuration rejects mutable image tags before opening host paths',
  suite.mutableImages.bind(suite),
);
test(
  'integration: Kata host package metadata projects the actual native sandbox provider',
  suite.declaration.bind(suite),
);
test(
  'integration: default Kata backend rejects unknown mutable and command-bearing input before effects',
  suite.rejectsUnknown.bind(suite),
);
test(
  'integration: Kata qualification fixture refuses an ordinary workstation before launching a daemon',
  suite.hostFixture.bind(suite),
);

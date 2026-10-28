import { expect, test } from 'bun:test';
import * as deployment from '../../src/diagnose.js';
import { spawnSync } from 'node:child_process';

interface Constructor { open(value: unknown): Promise<unknown>; }
class KataBackendAdmissionTests {
  async rejectsUnknown(): Promise<void> {
    const backend = Reflect.get(deployment, 'KataSandboxBackend') as Constructor;
    expect(typeof backend).toBe('function');
    for (const value of [null, {}, { image: 'busybox:latest' }, { command: 'host-script-canary' }])
      await expect(backend.open(value)).rejects.toThrow('KATA_CONFIGURATION_INVALID');
  }
  hostFixture(): void {
    const result = spawnSync(process.execPath, ['dist/tests/support/kata-backend-program.js'], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, GITHUB_ACTIONS: 'false' },
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  }
}
const suite = new KataBackendAdmissionTests();
test('integration: default Kata backend rejects unknown mutable and command-bearing input before effects', suite.rejectsUnknown.bind(suite));
test('integration: Kata qualification fixture refuses an ordinary workstation before launching a daemon', suite.hostFixture.bind(suite));

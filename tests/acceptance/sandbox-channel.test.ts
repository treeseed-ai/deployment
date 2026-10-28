import { test, expect } from 'bun:test';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
class SandboxChannelAcceptance {
  real(): void {
    const args = [
      '-n',
      'env',
      'PATH=/opt/kata/runtime-rs/bin:/opt/kata/bin:' + process.env.PATH,
      'GITHUB_ACTIONS=' + process.env.GITHUB_ACTIONS,
      'RUNNER_ENVIRONMENT=' + process.env.RUNNER_ENVIRONMENT,
      'RUNNER_TEMP=' + process.env.RUNNER_TEMP,
      'KATA_CONF_FILE=/opt/kata/share/defaults/kata-containers/runtime-rs/configuration-qemu-runtime-rs.toml',
      process.execPath,
      resolve('dist/tests/support/sandbox-channel-program.js'),
    ];
    const result = spawnSync('sudo', args, { encoding: 'utf8', timeout: 180000 });
    assert.equal(result.status, 0, result.stderr || 'Channel child exited without diagnostic');
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('sandbox-channel-kata-ok\n');
  }
  interface(): void {
    const result = spawnSync(
      'node',
      ['dist/tests/support/sandbox-channel-program.js', '--interface'],
      { encoding: 'utf8', timeout: 10000 },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('sandbox-channel-interface-ok\n');
  }
}
const suite = new SandboxChannelAcceptance();
test(
  'acceptance: built public private sandbox channel rejects invalid construction before host effects',
  suite.interface.bind(suite),
);

test(
  'acceptance: real default private sandbox channel authenticates and prepares an owned Kata guest',
  suite.real.bind(suite),
  185000,
);

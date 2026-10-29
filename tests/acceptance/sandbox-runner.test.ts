import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
class SandboxRunnerAcceptance {
  interface(): void {
    const result = spawnSync(
      'node',
      ['dist/tests/support/sandbox-runner-program.js', '--interface'],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'sandbox-runner-interface-ok\n');
  }
  hosted(): void {
    const args = [
      '-n',
      'env',
      'PATH=/opt/kata/runtime-rs/bin:/opt/kata/bin:' + process.env.PATH,
      'GITHUB_ACTIONS=' + process.env.GITHUB_ACTIONS,
      'RUNNER_ENVIRONMENT=' + process.env.RUNNER_ENVIRONMENT,
      'RUNNER_TEMP=' + process.env.RUNNER_TEMP,
      'KATA_CONF_FILE=/opt/kata/share/defaults/kata-containers/runtime-rs/configuration-qemu-runtime-rs.toml',
      process.execPath,
      resolve('dist/tests/support/sandbox-runner-program.js'),
    ];
    const result = spawnSync('sudo', args, { encoding: 'utf8', timeout: 180000 });
    assert.equal(
      result.status,
      0,
      result.stderr || 'Runner channel child exited without diagnostic',
    );
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'sandbox-runner-kata-ok\n');
  }
}
const suite = new SandboxRunnerAcceptance();
test(
  'acceptance: built public private sandbox runner client rejects invalid configuration before host effects',
  suite.interface.bind(suite),
);
test(
  'acceptance: real Kata guest readiness crosses the scoped private runner socket and fences grants',
  suite.hosted.bind(suite),
  185000,
);

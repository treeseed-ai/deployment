import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
class KataRunnerAcceptance {
  private readonly arguments = [
    '-n',
    'env',
    'PATH=/opt/kata/runtime-rs/bin:/opt/kata/bin:' + process.env.PATH,
    'GITHUB_ACTIONS=' + process.env.GITHUB_ACTIONS,
    'RUNNER_ENVIRONMENT=' + process.env.RUNNER_ENVIRONMENT,
    'RUNNER_TEMP=' + process.env.RUNNER_TEMP,
    'KATA_CONF_FILE=/opt/kata/share/defaults/kata-containers/runtime-rs/configuration-qemu-runtime-rs.toml',
    process.execPath,
    resolve('dist/tests/support/kata-runner-program.js'),
  ];
  interface(): void {
    const result = spawnSync(
      process.execPath,
      ['dist/tests/support/kata-runner-program.js', '--interface'],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'kata-runner-interface-ok\n');
  }
  hosted(): void {
    const result = spawnSync('sudo', this.arguments, { encoding: 'utf8', timeout: 180000 });
    assert.equal(
      result.status,
      0,
      result.stderr || 'Kata runner child exited without a diagnostic',
    );
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'kata-native-runner-ok\n');
  }
}
const suite = new KataRunnerAcceptance();
test(
  'acceptance: built default Kata backend admits exact native guest configuration without host effects',
  suite.interface.bind(suite),
);
test(
  'acceptance: real Kata holds the actual credential-free native Agent root and verifies physical destruction',
  suite.hosted.bind(suite),
  185000,
);

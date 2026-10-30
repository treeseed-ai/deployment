import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'bun:test';
class KataTaskConfigurationAcceptance {
  interface(): void {
    const result = spawnSync(
      'node',
      ['dist/tests/support/runtime-task-program.js', '--interface'],
      {
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'kata-task-configuration-interface-ok\n');
    assert.equal(result.stderr, '');
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
      resolve('dist/tests/support/runtime-task-program.js'),
    ];
    const result = spawnSync('sudo', args, { encoding: 'utf8', timeout: 180000 });
    assert.equal(result.status, 0, result.stderr || 'Native task configuration child failed');
    assert.equal(result.stdout, 'kata-task-configuration-public-ok\n');
    assert.equal(result.stderr, '');
  }
}
const suite = new KataTaskConfigurationAcceptance();
test(
  'acceptance: built public Kata configuration preserves defaults and rejects unsupported selection before host effects',
  suite.interface.bind(suite),
);
test(
  'acceptance: hosted native task options select retained private policy with finite boot bounds and verified destruction',
  suite.hosted.bind(suite),
  185000,
);

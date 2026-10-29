import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
class KataResourcesAcceptance {
  interface(): void {
    const result = spawnSync(
      process.execPath,
      ['dist/tests/support/kata-resources-program.js', '--interface'],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'kata-resources-interface-ok\n');
  }
  hosted(): void {
    const result = spawnSync(
      'sudo',
      [
        '-n',
        'env',
        'PATH=/opt/kata/runtime-rs/bin:/opt/kata/bin:' + process.env.PATH,
        'GITHUB_ACTIONS=' + process.env.GITHUB_ACTIONS,
        'RUNNER_ENVIRONMENT=' + process.env.RUNNER_ENVIRONMENT,
        'RUNNER_TEMP=' + process.env.RUNNER_TEMP,
        'KATA_CONF_FILE=/opt/kata/share/defaults/kata-containers/runtime-rs/configuration-qemu-runtime-rs.toml',
        process.execPath,
        resolve('dist/tests/support/kata-resources-program.js'),
      ],
      { encoding: 'utf8', timeout: 180000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'kata-resources-hosted-ok\n');
  }
}
const suite = new KataResourcesAcceptance();
test(
  'acceptance: built native Kata resource configuration is positive and bounded before host effects',
  suite.interface.bind(suite),
);
test(
  'acceptance: real Kata enforces workload CPU memory read-only root and bounded scratch with physical cleanup',
  suite.hosted.bind(suite),
  185000,
);

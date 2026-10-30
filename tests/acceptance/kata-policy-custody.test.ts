import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'bun:test';

class NativePolicyAcceptance {
  interface(): void {
    const result = spawnSync('node', ['dist/tests/support/native-policy-program.js'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'native-policy-interface-ok\n');
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
      resolve('dist/tests/support/native-policy-program.js'),
      '--hosted',
    ];
    const result = spawnSync('sudo', args, { encoding: 'utf8', timeout: 180000 });
    assert.equal(result.status, 0, result.stderr || 'Native policy lifecycle child failed');
    assert.equal(result.stdout, 'native-policy-lifecycle-ok\n');
    assert.equal(result.stderr, '');
  }
}
const suite = new NativePolicyAcceptance();
test(
  'acceptance: built native host policy selection rejects incomplete custody before effects',
  suite.interface.bind(suite),
);
test(
  'acceptance: hosted native Cordis host owns retained policy through launch inspection and disposal',
  suite.hosted.bind(suite),
  185000,
);

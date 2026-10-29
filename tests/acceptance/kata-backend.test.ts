import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

class KataBackendProgramAcceptance {
  boot(): void {
    const result = spawnSync('node', ['dist/tests/support/kata-boot-program.js'], {
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'generation-bound-boot-public-ok\n');
  }
  private readonly qualificationArguments = [
    '-n',
    'env',
    'PATH=/opt/kata/runtime-rs/bin:/opt/kata/bin:' + process.env.PATH,
    'GITHUB_ACTIONS=' + process.env.GITHUB_ACTIONS,
    'RUNNER_ENVIRONMENT=' + process.env.RUNNER_ENVIRONMENT,
    'RUNNER_TEMP=' + process.env.RUNNER_TEMP,
    'KATA_CONF_FILE=/opt/kata/share/defaults/kata-containers/runtime-rs/configuration-qemu-runtime-rs.toml',
    process.execPath,
    resolve('dist/tests/support/kata-backend-program.js'),
  ];
  interface(): void {
    const result = spawnSync(
      process.execPath,
      ['dist/tests/support/kata-backend-program.js', '--interface'],
      { encoding: 'utf8', timeout: 10000 },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('kata-interface-ok\n');
  }
  realGuest(): void {
    const result = spawnSync('sudo', this.qualificationArguments, {
      encoding: 'utf8',
      timeout: 180000,
    });
    assert.equal(result.status, 0, result.stderr || 'Kata child exited without a diagnostic');
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('owned-kata-backend-ok\n');
  }
}
const suite = new KataBackendProgramAcceptance();
test(
  'acceptance: built public Kata boot observer verifies a genuine harmless process generation',
  suite.boot.bind(suite),
  20000,
);
test(
  'acceptance: built default Kata backend rejects malformed configuration before any host effect',
  suite.interface.bind(suite),
);
test(
  'acceptance: real default Kata backend prepares assigned offline guests and verifies scoped destruction',
  suite.realGuest.bind(suite),
  185000,
);

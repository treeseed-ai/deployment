import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
class DockerPrerequisiteAcceptance {
  run(mode: string): void {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'docker-readiness-')));
    try {
      const bin = join(directory, 'bin');
      mkdirSync(bin, { mode: 0o700 });
      this.compile(join(bin, 'docker'));
      this.observe(directory, bin, mode);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  private compile(output: string): void {
    const result = spawnSync(
      process.execPath,
      [
        'build',
        resolve('tests/support/docker-readiness-peer.ts'),
        '--compile',
        '--outfile',
        output,
      ],
      { encoding: 'utf8', timeout: 30000 },
    );
    assert.equal(result.status, 0, result.stderr);
  }
  private invoke(bin: string, record: string, mode: string) {
    return spawnSync(process.execPath, [resolve('scripts/docker-prerequisite.ts')], {
      env: {
        PATH: bin + ':' + dirname(process.execPath),
        CORDIS_READINESS_RECORD: record,
        CORDIS_READINESS_MODE: mode,
      },
      encoding: 'utf8',
      timeout: 40000,
    });
  }
  private observe(directory: string, bin: string, mode: string): void {
    const record = join(directory, 'commands.jsonl');
    const result = this.invoke(bin, record, mode);
    const success = ['ready', 'preparation'].includes(mode);
    assert.equal(result.status, success ? 0 : 1, result.stderr);
    assert.equal(result.stdout, success ? 'DOCKER_PREREQUISITE_QUALIFIED\n' : '');
    assert.equal(result.stderr, success ? '' : 'DOCKER_PREREQUISITE_UNREADY\n');
    const calls = readFileSync(record, 'utf8').trim().split('\n');
    assert.equal(calls.length, mode === 'failure' ? 1 : 2);
    for (const call of calls)
      assert.deepEqual(JSON.parse(call), [
        '--context',
        'default',
        'info',
        '--format',
        '{{json .}}',
      ]);
  }
}
const suite = new DockerPrerequisiteAcceptance();
for (const mode of ['ready', 'preparation', 'failure', 'unresponsive'])
  test(
    'acceptance: CI Docker qualification preserves bounded preparation and exact observation for ' +
      mode,
    suite.run.bind(suite, mode),
    45000,
  );

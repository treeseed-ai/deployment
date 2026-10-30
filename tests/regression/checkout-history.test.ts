import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
class CheckoutHistoryRegression {
  private readonly workflow = readFileSync('.github/workflows/verify.yml', 'utf8');
  private script(): string {
    const match = this.workflow.match(/CANDIDATE_SHA:.*\n        run: \|\n((?:          .+\n)+)/);
    assert(match, 'exact candidate and complete history gate must exist');
    return match[1]!.split('\n').map(CheckoutHistoryRegression.unindent).join('\n');
  }
  private static unindent(line: string): string {
    return line.replace(/^          /, '');
  }
  private git(directory: string, args: string[]): string {
    const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  private fixture(): { directory: string; candidate: string } {
    const directory = mkdtempSync(join(tmpdir(), 'checkout-history-'));
    this.git(directory, ['init', '-q']);
    this.commit(directory, 'base');
    this.git(directory, ['update-ref', 'refs/remotes/origin/cordis', 'HEAD']);
    this.commit(directory, 'candidate');
    const candidate = this.git(directory, ['rev-parse', 'HEAD']);
    this.git(directory, ['switch', '--detach', 'origin/cordis']);
    return { directory, candidate };
  }
  private commit(directory: string, message: string): void {
    this.git(directory, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@invalid',
      'commit',
      '--allow-empty',
      '-qm',
      message,
    ]);
  }
  private run(directory: string, candidate: string): number | null {
    const result = spawnSync('bash', ['-e', '-c', this.script()], {
      cwd: directory,
      env: { ...process.env, CANDIDATE_SHA: candidate },
      encoding: 'utf8',
      timeout: 10000,
    });
    return result.status;
  }
  gate(): void {
    const { directory, candidate } = this.fixture();
    assert.equal(this.run(directory, candidate), 0);
    assert.equal(this.git(directory, ['rev-parse', 'HEAD']), candidate);
    assert.notEqual(this.run(directory, 'invalid-candidate'), 0);
    assert.notEqual(this.run(directory, 'f'.repeat(40)), 0);
    this.git(directory, ['update-ref', '-d', 'refs/remotes/origin/cordis']);
    assert.notEqual(this.run(directory, candidate), 0);
  }
  shallow(): void {
    const { directory, candidate } = this.fixture();
    writeFileSync(join(directory, '.git/shallow'), candidate + '\n');
    assert.equal(this.git(directory, ['rev-parse', '--is-shallow-repository']), 'true');
    assert.notEqual(this.run(directory, candidate), 0);
  }
  selections(): void {
    const parts = this.workflow.split('    steps:\n').slice(1, 3);
    assert.equal(parts.length, 2);
    for (const part of parts) {
      assert.equal(part.match(/fetch-depth: 2147483647/g)?.length, 2);
      assert.equal(part.match(/filter: blob:limit=1m/g)?.length, 2);
      assert.equal(part.match(/persist-credentials: false/g)?.length, 2);
      assert(part.includes('ref: refs/heads/cordis'));
      assert(part.includes('ref: ${{ github.event.pull_request.head.sha || github.sha }}'));
      assert(!part.includes('fetch-depth: 0'));
    }
  }
  gates(): void {
    assert(
      this.workflow.includes(
        'partition: [foundation, kata, transitions, sources, runtime, git-installed, registered, build-registered]',
      ),
    );
    assert.equal(this.workflow.match(/timeout-minutes: 15/g)?.length, 2);
    assert.equal(this.workflow.match(/runs-on: ubuntu-26.04/g)?.length, 3);
    assert(
      this.workflow.includes(
        'bun run check && bun run build && bun run test:regression && bun run test:integration && bun run test:unit',
      ),
    );
    assert(this.workflow.includes('bun scripts/verification.ts smoke ${{ matrix.partition }}'));
    this.kata();
  }
  private kata(): void {
    assert(
      this.workflow.includes('3dc6b69c4acb787b967b04b64599a20d02a8beb1a8eaab3084110df9d0b08c96'),
    );
    assert(
      this.workflow.includes('github.event.pull_request.head.repo.full_name == github.repository'),
    );
    assert(
      this.workflow.includes("needs.checks.result == 'success' && needs.smoke.result == 'success'"),
    );
  }
}
const suite = new CheckoutHistoryRegression();
test(
  'regression: CI checkout targets complete candidate and Cordis history without retaining credentials',
  suite.selections.bind(suite),
);
test(
  'regression: actual checkout gate rejects missing integration and invalid candidate identities',
  suite.gate.bind(suite),
);
test('regression: actual checkout gate rejects a shallow repository', suite.shallow.bind(suite));
test(
  'regression: bounded checkout preserves every hosted runtime qualification gate',
  suite.gates.bind(suite),
);

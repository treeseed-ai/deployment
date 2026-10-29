import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
class PlanningEvidenceAcceptance {
  plan(): void {
    this.program([], 'planning-evidence-ok\n');
  }
  formatter(): void {
    this.program(['--formatter'], 'source-formatter-ok\n');
  }
  private program(args: string[], output: string): void {
    const result = spawnSync('node', ['dist/tests/support/planning-evidence-program.js', ...args], {
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, output);
  }
}
const suite = new PlanningEvidenceAcceptance();
test(
  'acceptance: built default planner retains safe exact failure cause without changing blocker envelopes or creating state',
  suite.plan.bind(suite),
  20000,
);
test(
  'acceptance: built source and installed fixtures import without execution and retain only safe exact failure evidence',
  suite.formatter.bind(suite),
  20000,
);

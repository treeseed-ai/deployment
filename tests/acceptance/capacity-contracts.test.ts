import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
class CapacityContractAcceptance {
  run(): void {
    const result = spawnSync('node', ['dist/tests/support/capacity-contract-program.js'], {
      encoding: 'utf8', timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('deployment-capacity-contracts-ok\n');
  }
}
const suite = new CapacityContractAcceptance();
test('acceptance: built Deployment default construction retains public SDK capacity contracts', suite.run.bind(suite));

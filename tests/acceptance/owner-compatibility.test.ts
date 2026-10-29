import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
class OwnerCompatibilityAcceptance {
  static program(): void {
    const result = spawnSync('node', ['dist/tests/support/owner-compatibility-program.js'],
      { encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('deployment-owner-availability-closure-ok\n');
    expect(result.stderr).toBe('');
  }
}
test('acceptance: built Deployment selects one exact availability-compatible SDK closure', OwnerCompatibilityAcceptance.program);

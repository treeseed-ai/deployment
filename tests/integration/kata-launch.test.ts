import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test, beforeAll, afterEach, afterAll } from 'bun:test';
import { RuntimePolicyFixture } from '../support/runtime-policy-program.js';
import { LaunchCapability } from '../support/runtime-launch-program.js';
class LaunchPolicyBoundaries {
  private readonly fixture = new RuntimePolicyFixture();
  private getterCalls = 0;
  async prepare(): Promise<void> {
    LaunchCapability.type();
    await this.fixture.prepare();
  }
  release(): void {
    for (const policy of this.fixture.held) policy.close();
    this.fixture.held.length = 0;
  }
  close(): void {
    this.fixture.close();
  }
  private safe(expected: string, error: unknown): boolean {
    assert(error instanceof Error);
    assert.equal(error.message, expected);
    assert.equal(Reflect.get(error, 'cause'), undefined);
    assert(!String(error).includes('PRIVATE_'));
    return true;
  }
  async rejected(mode: string): Promise<void> {
    const Constructor = LaunchCapability.type(),
      policy = await this.fixture.open();
    if (mode === 'closed') policy.close();
    const signal = mode === 'cancelled' ? AbortSignal.abort() : this.fixture.signal;
    const expected = mode === 'cancelled' ? 'KATA_CANCELLED' : 'KATA_LAUNCH_INVALID';
    const before = readdirSync(this.fixture.directory).sort();
    await assert.rejects(
      Constructor.open.bind(Constructor, policy, 'cordis-sandbox-fixture', signal),
      this.safe.bind(this, expected),
    );
    assert.deepEqual(readdirSync(this.fixture.directory).sort(), before);
    this.fixture.components!.verify();
    this.fixture.aliases!.verify();
    this.fixture.archive!.verify();
  }
  async forged(): Promise<void> {
    const Constructor = LaunchCapability.type();
    const policy = Object.defineProperty({}, 'proof', { get: this.getter.bind(this) });
    await assert.rejects(
      Constructor.open.bind(Constructor, policy, 'cordis-sandbox-fixture', this.fixture.signal),
      this.safe.bind(this, 'KATA_LAUNCH_INVALID'),
    );
    assert.equal(this.getterCalls, 0);
  }
  private getter(): never {
    this.getterCalls++;
    throw new Error('PRIVATE_POLICY_GETTER');
  }
}
const suite = new LaunchPolicyBoundaries();
beforeAll(suite.prepare.bind(suite), 300000);
afterEach(suite.release.bind(suite));
afterAll(suite.close.bind(suite));
for (const mode of ['relocated', 'closed', 'cancelled'])
  test(
    'integration: native launch rejects ' + mode + ' genuine borrowed policy without host effects',
    suite.rejected.bind(suite, mode),
  );
test(
  'integration: native launch rejects forged policy without invoking getters',
  suite.forged.bind(suite),
);

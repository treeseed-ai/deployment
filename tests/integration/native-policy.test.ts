import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readdirSync, readlinkSync } from 'node:fs';
import { test, beforeAll, afterAll } from 'bun:test';
import * as Sandbox from '@treeseed-cordis/deployment/sandbox';
import { RuntimePolicyFixture } from '../support/runtime-policy-program.js';
import { TASK_CONFIGURATION_INPUT } from '../support/runtime-task-program.js';

interface NativeCustody {
  verify(): void;
  close(): void;
}
interface NativeCustodyFactory {
  open(input: unknown, archive: unknown, signal: AbortSignal): Promise<NativeCustody | null>;
}
class NativePolicyCustodyBoundaries {
  private readonly fixture = new RuntimePolicyFixture();
  async prepare(): Promise<void> {
    await this.fixture.prepare();
  }
  close(): void {
    this.fixture.close();
  }
  private factory(): NativeCustodyFactory {
    const Type = Reflect.get(Sandbox, 'NativePolicyCustody') as unknown as NativeCustodyFactory;
    assert.equal(typeof Type?.open, 'function', 'Native policy custody construction missing');
    return Type as NativeCustodyFactory;
  }
  private input(): object {
    const bindings = this.fixture.components!.bindings;
    return {
      ...TASK_CONFIGURATION_INPUT,
      resources: this.fixture.resources,
      runtime: {
        ...TASK_CONFIGURATION_INPUT.runtime,
        configurationMode: 'task-options',
        archive: {
          ...this.fixture.archive!.proof,
          path: join(this.fixture.directory, 'kit.tar.zst'),
        },
        configuration: this.fixture.configuration,
        shim: this.binding('shim'),
        hypervisor: this.binding('hypervisor'),
        policy: { components: bindings },
      },
    };
  }
  private binding(role: string): { path: string; sha256: string } {
    const binding = this.fixture.components!.bindings.find(this.role.bind(null, role));
    const member = this.fixture.components!.proof.components.find(this.role.bind(null, role));
    assert(binding && member);
    return { path: binding.path, sha256: member.member.sha256 };
  }
  private role(expected: string, value: { role: string }): boolean {
    return value.role === expected;
  }
  private descriptors(): string[] {
    const paths = [];
    for (const fd of readdirSync('/proc/self/fd'))
      try {
        const path = readlinkSync('/proc/self/fd/' + fd);
        if (path.startsWith(this.fixture.directory + '/')) paths.push(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    return paths.sort();
  }
  async refused(mode: string): Promise<void> {
    const factory = this.factory();
    const archive = this.fixture.archive!;
    const before = this.descriptors();
    const signal = mode === 'cancelled' ? AbortSignal.abort() : this.fixture.signal;
    await assert.rejects(factory.open.bind(factory, this.input(), archive, signal), {
      message: mode === 'cancelled' ? 'KATA_CANCELLED' : 'KATA_NATIVE_POLICY_INVALID',
    });
    assert.deepEqual(this.descriptors(), before);
    archive.verify();
    this.fixture.components!.verify();
    this.fixture.aliases!.verify();
  }
  async closed(): Promise<void> {
    const factory = this.factory();
    const archive = await Sandbox.RuntimeArchiveCustody.open(
      { ...this.fixture.archive!.proof, path: join(this.fixture.directory, 'kit.tar.zst') },
      this.fixture.signal,
    );
    archive.close();
    const before = this.descriptors();
    await assert.rejects(factory.open.bind(factory, this.input(), archive, this.fixture.signal), {
      message: 'KATA_NATIVE_POLICY_INVALID',
    });
    assert.deepEqual(this.descriptors(), before);
    this.fixture.archive!.verify();
  }
  async compatible(): Promise<void> {
    const factory = this.factory();
    const before = this.descriptors();
    assert.equal(await factory.open(TASK_CONFIGURATION_INPUT, null, this.fixture.signal), null);
    assert.deepEqual(this.descriptors(), before);
    this.fixture.archive!.verify();
  }
  async mismatched(): Promise<void> {
    const factory = this.factory();
    const input = this.input() as { runtime: { archive: { sha256: string } } };
    input.runtime.archive.sha256 = '0'.repeat(64);
    const before = this.descriptors();
    await assert.rejects(
      factory.open.bind(factory, input, this.fixture.archive, this.fixture.signal),
      {
        message: 'KATA_NATIVE_POLICY_INVALID',
      },
    );
    assert.deepEqual(this.descriptors(), before);
    this.fixture.archive!.verify();
  }
}
const suite = new NativePolicyCustodyBoundaries();
beforeAll(suite.prepare.bind(suite), 300000);
afterAll(suite.close.bind(suite));
for (const mode of ['relocated', 'cancelled'])
  test(
    'integration: native policy custody refuses ' +
      mode +
      ' inert installed kit without descriptor leaks',
    suite.refused.bind(suite, mode),
    300000,
  );
test(
  'integration: native policy custody rejects closed borrowed archive and preserves other owners',
  suite.closed.bind(suite),
  300000,
);
test(
  'integration: native policy custody preserves unconfigured mode without taking descriptors',
  suite.compatible.bind(suite),
);
test(
  'integration: native policy custody binds the selected archive hash to genuine borrowed custody',
  suite.mismatched.bind(suite),
);

import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as sdk from '@treeseed-cordis/sdk/portable';
class CapacitySdkClosureTests {
  installed(): void {
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
    const installed = JSON.parse(
      readFileSync('node_modules/@treeseed-cordis/sdk/package.json', 'utf8'),
    );
    expect(metadata.peerDependencies['@treeseed-cordis/sdk']).toBe('0.0.0-cordis.37');
    expect(installed.version).toBe(metadata.peerDependencies['@treeseed-cordis/sdk']);
    expect(metadata.cordisCandidate.sdk.commit).toBe('dce3108e061ecaf0cfa2915c03698f0e3170a67b');
    const digest = '886a9f359148a1aee49997de7e0604c65c87bf16c693d23781c5732f41990384';
    expect(metadata.cordisCandidate.sdk.sha256).toBe(digest);
    expect(createHash('sha256').update(readFileSync('vendor/sdk.tgz')).digest('hex')).toBe(digest);
  }
  protocols(): void {
    for (const name of [
      'ActivitySchemas',
      'EnvironmentSchemas',
      'CapacitySchemas',
      'PoolSchemas',
      'CapacityProtocolSchemas',
      'SandboxControlSchemas',
      'SandboxControlBinding',
      'CapacityChannelSchemas',
      'CapacityChannelBinding',
    ])
      expect(typeof Reflect.get(sdk, name)).toBe('function');
    expect(sdk.PlatformOperations.all).toHaveLength(7);
  }
}
const suite = new CapacitySdkClosureTests();
test(
  'unit: Deployment guest control binds the reviewed selected and installed SDK closure',
  suite.installed.bind(suite),
);
test(
  'unit: Deployment receives the complete portable capacity and environment contracts',
  suite.protocols.bind(suite),
);

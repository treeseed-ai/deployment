import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as sdk from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost } from '../../src/diagnose.js';
export const CapacityContractSymbols = [
  'ActivitySchemas',
  'EnvironmentSchemas',
  'PoolSchemas',
  'CapacityProtocolSchemas',
  'SandboxControlSchemas',
  'SandboxControlBinding',
  'CapacityChannelSchemas',
  'CapacityChannelBinding',
  'SandboxRunnerSchemas',
  'SandboxRunnerBinding',
  'GuestRuntimeSchemas',
  'GuestRuntimeBinding',
  'SandboxProfileSchemas',
  'SandboxProfileBinding',
  'SandboxProfileError',
  'CapacitySchemas',
] as const;
class CapacityContractProgram {
  run(): void {
    this.selection();
    this.contracts();
    assert.equal(sdk.PlatformOperations.all.length, 7);
    assert.equal(typeof new ComposeDeploymentHost().plan, 'function');
    process.stdout.write('deployment-capacity-contracts-ok\n');
  }
  private contracts(): void {
    assert.equal(typeof Reflect.get(sdk, 'CapacitySchemas'), 'function');
    assert.equal(typeof Reflect.get(sdk, 'SeedSchemas'), 'function');
    for (const name of CapacityContractSymbols)
      assert.equal(typeof Reflect.get(sdk, name), 'function');
  }
  private selection(): void {
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
    const digest = createHash('sha256').update(readFileSync('vendor/sdk.tgz')).digest('hex');
    assert.equal(metadata.peerDependencies['@treeseed-cordis/sdk'], '0.0.0-cordis.41');
    assert.equal(metadata.cordisCandidate.sdk.commit, '4bb54954ac6d636309a8312c2bf71536b5aefb73');
    assert.equal(digest, '2bbde1a4ca35fbffaeacb2fbeab40b49f56dc57dca3355e8e47e22ed5f0f822a');
    assert.equal(metadata.cordisCandidate.sdk.sha256, digest);
  }
}
if (import.meta.main) new CapacityContractProgram().run();

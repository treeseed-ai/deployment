import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as sdk from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost } from '../../src/diagnose.js';
class CapacityContractProgram {
  run(): void {
    this.selection();
    assert.equal(typeof Reflect.get(sdk, 'CapacitySchemas'), 'function');
    assert.equal(typeof Reflect.get(sdk, 'SeedSchemas'), 'function');
    for (const name of [
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
    ])
      assert.equal(typeof Reflect.get(sdk, name), 'function');
    assert.equal(sdk.PlatformOperations.all.length, 7);
    assert.equal(typeof new ComposeDeploymentHost().plan, 'function');
    process.stdout.write('deployment-capacity-contracts-ok\n');
  }
  private selection(): void {
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
    const digest = createHash('sha256').update(readFileSync('vendor/sdk.tgz')).digest('hex');
    assert.equal(metadata.peerDependencies['@treeseed-cordis/sdk'], '0.0.0-cordis.39');
    assert.equal(metadata.cordisCandidate.sdk.commit, 'f09247dbf020f0354edce9af2f9ccef6ba351ff3');
    assert.equal(digest, 'ddfb91a065bee6d7e9482427570e7c036b18f0fbbcaa09c0fc62fee094abdbd4');
    assert.equal(metadata.cordisCandidate.sdk.sha256, digest);
  }
}
if (import.meta.main) new CapacityContractProgram().run();

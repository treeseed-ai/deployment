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
    ])
      assert.equal(typeof Reflect.get(sdk, name), 'function');
    assert.equal(sdk.PlatformOperations.all.length, 7);
    assert.equal(typeof new ComposeDeploymentHost().plan, 'function');
    process.stdout.write('deployment-capacity-contracts-ok\n');
  }
  private selection(): void {
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
    const digest = createHash('sha256').update(readFileSync('vendor/sdk.tgz')).digest('hex');
    assert.equal(metadata.peerDependencies['@treeseed-cordis/sdk'], '0.0.0-cordis.38');
    assert.equal(metadata.cordisCandidate.sdk.commit, '9ceaa50767f7644755bec1c8f8beffbcd05517ed');
    assert.equal(digest, '92858c0288b38aa30cb037e61f5da37e91e0c64f5690629b3a96ab3db6631011');
    assert.equal(metadata.cordisCandidate.sdk.sha256, digest);
  }
}
if (import.meta.main) new CapacityContractProgram().run();

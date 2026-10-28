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
    for (const name of ['ActivitySchemas', 'EnvironmentSchemas', 'PoolSchemas', 'CapacityProtocolSchemas','SandboxControlSchemas','SandboxControlBinding'])
      assert.equal(typeof Reflect.get(sdk, name), 'function');
    assert.equal(sdk.PlatformOperations.all.length, 7);
    assert.equal(typeof new ComposeDeploymentHost().plan, 'function');
    process.stdout.write('deployment-capacity-contracts-ok\n');
  }
  private selection(): void {
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
    const digest = createHash('sha256').update(readFileSync('vendor/sdk.tgz')).digest('hex');
    assert.equal(metadata.peerDependencies['@treeseed-cordis/sdk'], '0.0.0-cordis.36');
    assert.equal(metadata.cordisCandidate.sdk.commit, '0ae4f3973672e5c66ee021e7748c2ea73f7cb21c');
    assert.equal(digest, '04cea0518a3d64228cfbdad73a357d18cc7040e4bc7a122833dddd9de96ed000');
    assert.equal(metadata.cordisCandidate.sdk.sha256, digest);
  }
}
if (import.meta.main) new CapacityContractProgram().run();

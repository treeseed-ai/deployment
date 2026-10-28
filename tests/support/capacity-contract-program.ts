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
    for (const name of ['ActivitySchemas', 'EnvironmentSchemas', 'PoolSchemas', 'CapacityProtocolSchemas','SandboxControlSchemas','SandboxControlBinding','CapacityChannelSchemas','CapacityChannelBinding'])
      assert.equal(typeof Reflect.get(sdk, name), 'function');
    assert.equal(sdk.PlatformOperations.all.length, 7);
    assert.equal(typeof new ComposeDeploymentHost().plan, 'function');
    process.stdout.write('deployment-capacity-contracts-ok\n');
  }
  private selection(): void {
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
    const digest = createHash('sha256').update(readFileSync('vendor/sdk.tgz')).digest('hex');
    assert.equal(metadata.peerDependencies['@treeseed-cordis/sdk'], '0.0.0-cordis.37');
    assert.equal(metadata.cordisCandidate.sdk.commit, 'dce3108e061ecaf0cfa2915c03698f0e3170a67b');
    assert.equal(digest, '886a9f359148a1aee49997de7e0604c65c87bf16c693d23781c5732f41990384');
    assert.equal(metadata.cordisCandidate.sdk.sha256, digest);
  }
}
if (import.meta.main) new CapacityContractProgram().run();

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
    assert.equal(sdk.PlatformOperations.all.length, 7);
    assert.equal(typeof new ComposeDeploymentHost().plan, 'function');
    process.stdout.write('deployment-capacity-contracts-ok\n');
  }
  private selection(): void {
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
    const digest = createHash('sha256').update(readFileSync('vendor/sdk.tgz')).digest('hex');
    assert.equal(metadata.peerDependencies['@treeseed-cordis/sdk'], '0.0.0-cordis.19');
    assert.equal(metadata.cordisCandidate.sdk.commit, '90cf4f3cc62e166685280450c727499defd2af5b');
    assert.equal(digest, '93dd549c98aba180306e9b19cc1cbc37494544b2764ed341c531c9af618c6f81');
    assert.equal(metadata.cordisCandidate.sdk.sha256, digest);
  }
}
if (import.meta.main) new CapacityContractProgram().run();

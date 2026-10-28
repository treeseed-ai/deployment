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
    for (const name of ['ActivitySchemas', 'EnvironmentSchemas', 'PoolSchemas', 'CapacityProtocolSchemas'])
      assert.equal(typeof Reflect.get(sdk, name), 'function');
    assert.equal(sdk.PlatformOperations.all.length, 7);
    assert.equal(typeof new ComposeDeploymentHost().plan, 'function');
    process.stdout.write('deployment-capacity-contracts-ok\n');
  }
  private selection(): void {
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
    const digest = createHash('sha256').update(readFileSync('vendor/sdk.tgz')).digest('hex');
    assert.equal(metadata.peerDependencies['@treeseed-cordis/sdk'], '0.0.0-cordis.35');
    assert.equal(metadata.cordisCandidate.sdk.commit, 'bc6cb6610fd5ddc13639b3c3bc8b709ed930d647');
    assert.equal(digest, '98a4474726b79c1ce1a4b96a76e636a3dafa8e20df3dc66db89331ae79b31fbf');
    assert.equal(metadata.cordisCandidate.sdk.sha256, digest);
  }
}
if (import.meta.main) new CapacityContractProgram().run();

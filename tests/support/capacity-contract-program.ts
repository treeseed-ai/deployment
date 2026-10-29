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
    assert.equal(sdk.CapacityChannelSchemas.context.shape.role.safeParse('manager').success, true);
    assert.equal(sdk.CapacityChannelSchemas.version, '1.1.0-cordis.1');
    for (const name of CapacityContractSymbols)
      assert.equal(typeof Reflect.get(sdk, name), 'function');
  }
  private selection(): void {
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
    const digest = createHash('sha256').update(readFileSync('vendor/sdk.tgz')).digest('hex');
    assert.equal(metadata.peerDependencies['@treeseed-cordis/sdk'], '0.0.0-cordis.42');
    assert.equal(metadata.cordisCandidate.sdk.commit, 'afdfac7bdd3c9c1f783362cd1d50324181e1d725');
    assert.equal(digest, '0ecfe599916fe8ef364fc4b73203c810981f163109fbe71a0dd4c01a9dfb7bbc');
    assert.equal(metadata.cordisCandidate.sdk.sha256, digest);
  }
}
if (import.meta.main) new CapacityContractProgram().run();

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as Sdk from '@treeseed-cordis/sdk';
import * as Control from '@treeseed-cordis/sdk/provider-control';
export class OwnerCompatibilityProgram {
  static run(): void {
    const owner = JSON.parse(readFileSync('package.json', 'utf8'));
    const sdk = JSON.parse(readFileSync('node_modules/@treeseed-cordis/sdk/package.json', 'utf8'));
    assert.equal(owner.peerDependencies['@treeseed-cordis/sdk'], '0.0.0-cordis.44');
    assert.equal(sdk.version, '0.0.0-cordis.44');
    assert.equal(createHash('sha256').update(readFileSync('vendor/sdk.tgz')).digest('hex'),
      'd95c54cf6081c7634498dfb4f3235d42d65b8664a5d62cc87c4dd4e85381f0f3');
    const availability = Reflect.get(Sdk, 'ProviderAvailabilitySchemas');
    assert.equal(Reflect.get(availability, 'version'), 'treeseed.provider-availability/v1');
    assert.equal(Sdk.CapacityChannelSchemas.version, '1.1.0-cordis.1');
    assert.equal(Sdk.PlatformOperations.all.length, 7);
    for (const method of ['createAvailabilitySession', 'refreshAvailabilitySession', 'closeAvailabilitySession'])
      assert.equal(typeof Reflect.get(Control.ProviderProtocolClient.prototype, method), 'function');
    process.stdout.write('deployment-owner-availability-closure-ok\n');
  }
}
if (import.meta.main) OwnerCompatibilityProgram.run();

import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as sdk from '@treeseed-cordis/sdk/portable';
import { CapacityContractSymbols } from '../support/capacity-contract-program.js';
class CapacitySdkClosureTests {
  installed(): void {
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
    const installed = JSON.parse(
      readFileSync('node_modules/@treeseed-cordis/sdk/package.json', 'utf8'),
    );
    expect(metadata.peerDependencies['@treeseed-cordis/sdk']).toBe('0.0.0-cordis.41');
    expect(installed.version).toBe(metadata.peerDependencies['@treeseed-cordis/sdk']);
    expect(metadata.cordisCandidate.sdk.commit).toBe('4bb54954ac6d636309a8312c2bf71536b5aefb73');
    const digest = '2bbde1a4ca35fbffaeacb2fbeab40b49f56dc57dca3355e8e47e22ed5f0f822a';
    expect(metadata.cordisCandidate.sdk.sha256).toBe(digest);
    expect(createHash('sha256').update(readFileSync('vendor/sdk.tgz')).digest('hex')).toBe(digest);
  }
  protocols(): void {
    for (const name of CapacityContractSymbols)
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

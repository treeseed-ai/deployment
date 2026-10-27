import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { create } from 'tar';
import { CanonicalJson } from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost } from '../../src/diagnose.js';
import { ServiceReleaseFixture } from '../support/release-fixture.js';
import {SourcePolicyTests} from '../support/source-policy-test-support.js';
class SourcePolicyTestsIntegration extends SourcePolicyTests {

    async blocked(): Promise<void> {
        for (const mode of ['helper', 'certificate', 'symlink', 'build']) {
            const fixture = await this.fixture();
            try {
                if (mode === 'helper')
                    fixture.release.acquisitionPolicy!.helperReleaseIdentity = 'f'.repeat(64);
                if (mode === 'certificate')
                    writeFileSync(join(fixture.bundle, 'source-ca.pem'), 'TAMPERED');
                if (mode === 'symlink') {
                    unlinkSync(join(fixture.bundle, 'source-ca.pem'));
                    symlinkSync(join(fixture.root, 'inspection-helper/tool'), join(fixture.bundle, 'source-ca.pem'));
                }
                if (mode === 'build') {
                    const policy = fixture.release.acquisitionPolicy!;
                    policy.git = [{ origin: 'https://github.com/fixture/plugin.git', packages: ['@fixture/plugin'], targets: ['deployment'], buildPolicyDigest: 'b'.repeat(64) }];
                    policy.builds = [{ id: 'b'.repeat(64), origin: policy.git[0]!.origin, commit: 'c'.repeat(40), entry: 'build.ts', entryDigest: 'd'.repeat(64), packageDirectory: 'package', image: 'registry.invalid/build@sha256:' + 'e'.repeat(64), helperReleaseIdentity: policy.helperReleaseIdentity, network: 'none', timeoutMs: 120000 }];
                }
                fixture.refreshService();
                await expect(new ComposeDeploymentHost().plan(fixture.configuration)).rejects.toThrow();
                expect(existsSync(fixture.installation)).toBe(false);
            }
            finally {
                fixture.close();
            }
        }
    }
}
const suite=new SourcePolicyTestsIntegration();
test('integration: source policy wrong helpers changed CA symlinks and unbound build identities block before persistence', suite.blocked.bind(suite), 60000);

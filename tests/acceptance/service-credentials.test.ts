import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceReleaseFixture } from '../support/release-fixture.js';
import { ServiceProjection } from '../../src/service-projection.js';
import { CredentialContainerFixture } from '../support/service-fixture-plugins.js';
import { ServiceSchemas, CanonicalJson } from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost, ServicePlanStore, ServiceCredentials } from '../../src/diagnose.js';
class CredentialTestsAcceptance {

    async program(): Promise<void> { const fixture = await new ServiceReleaseFixture().withCredentials(); try {
        const input = join(fixture.root, 'credential-input.json');
        writeFileSync(input, JSON.stringify(fixture.configuration));
        const result = spawnSync('node', ['dist/tests/support/service-credentials-program.js', input], { encoding: 'utf8', timeout: 30000 });
        if (result.status !== 0)
            throw new Error(result.stderr);
        expect(JSON.parse(result.stdout)).toEqual({ fixtureOnly: true, slots: 8, referenceCount: 8, ready: false });
        const store = new ServicePlanStore(fixture.installation);
        for (const resource of store.resources()) {
            expect(resource.contentDigest).toMatch(/^[a-f0-9]{64}$/);
            expect(resource.path).toMatch(/^credentials\//);
            expect(statSync(join(fixture.installation, '.cordis', resource.path!)).mode & 0o777).toBe(0o600);
        }
        expect(existsSync(join(fixture.root, 'SCRIPT_CANARY'))).toBe(false);
    }
    finally {
        fixture.close();
    } }
}
const suite=new CredentialTestsAcceptance();
test("acceptance: built slot custodian isolates instances resolves grants and retains private bytes", suite.program.bind(suite), 30000);

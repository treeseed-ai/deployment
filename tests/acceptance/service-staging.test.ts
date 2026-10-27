import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { create } from 'tar';
import { ServiceReleaseFixture } from '../support/release-fixture.js';
import { ComposeDeploymentHost, ServicePlanStore, ServiceProviderStager } from '../../src/diagnose.js';
import {ServiceStagingTests} from '../support/service-staging-test-support.js';
class ServiceStagingTestsAcceptance extends ServiceStagingTests {

    async program(): Promise<void> { const fixture = await new ServiceReleaseFixture().services(); try {
        const input = join(fixture.root, 'staging-input.json');
        writeFileSync(input, JSON.stringify(fixture.configuration));
        expect(existsSync(join(fixture.root, 'SCRIPT_CANARY'))).toBe(false);
        const result = spawnSync('node', ['dist/tests/support/service-staging-program.js', input], { encoding: 'utf8', timeout: 30000 });
        if (result.status !== 0)
            throw new Error(result.stderr);
        expect(JSON.parse(result.stdout)).toEqual({ fixtureOnly: true, identities: ['instance-0', 'instance-1'] });
        expect(existsSync(join(fixture.root, 'SCRIPT_CANARY'))).toBe(true);
        const providers = join(fixture.installation, '.cordis/artifacts/providers');
        for (const name of readdirSync(providers)) {
            expect(name).toMatch(/^[a-f0-9]{64}$/);
            expect(statSync(join(providers, name)).mode & 0o777).toBe(0o500);
            const manifest = JSON.parse(readFileSync(join(providers, name, 'manifest.json'), 'utf8'));
            expect(manifest.formatVersion).toBe(2);
            expect(statSync(join(providers, name, 'manifest.json')).mode & 0o777).toBe(0o400);
            for (const entry of manifest.files)
                expect(statSync(join(providers, name, entry.path)).mode & 0o777).toBe(0o400);
        }
        expect(existsSync(join(fixture.installation, '.cordis/credentials'))).toBe(false);
    }
    finally {
        fixture.close();
    } }
}
const suite=new ServiceStagingTestsAcceptance();
test("acceptance: built stager loads genuine archive classes through two native Cordis scopes", suite.program.bind(suite), 30000);

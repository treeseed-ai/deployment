import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceReleaseFixture } from '../support/release-fixture.js';
import { ComposeDeploymentHost, ServicePlanStore, ServiceImages } from '../../src/diagnose.js';
class ServiceImageTestsAcceptance {

    async program(): Promise<void> { const fixture = await new ServiceReleaseFixture().services(); try {
        const before = spawnSync('docker', ['image', 'inspect', 'sha256:' + fixture.release.images[0]!.manifestDigest], { encoding: 'utf8' });
        expect(before.status).not.toBe(0);
        const input = join(fixture.root, 'image-input.json');
        writeFileSync(input, JSON.stringify(fixture.configuration));
        const result = spawnSync('node', ['dist/tests/support/service-images-program.js', input], { encoding: 'utf8', timeout: 120000 });
        if (result.status !== 0)
            throw new Error(result.stderr);
        const report = JSON.parse(result.stdout);
        expect(report.fixtureOnly).toBe(true);
        expect(report.ready).toBe(false);
        expect(report.bindings.application.manifestDigest).toBe(fixture.release.images[0]!.manifestDigest);
        expect(report.bindings.application.dockerId).toMatch(/^sha256:[a-f0-9]{64}$/);
        const cache = join(fixture.installation, '.cordis/artifacts/images');
        expect(readdirSync(cache)).toEqual([fixture.release.images[0]!.manifestDigest]);
        expect(existsSync(join(cache, fixture.release.images[0]!.manifestDigest, 'binding.json'))).toBe(true);
    }
    finally {
        fixture.close();
    } }
}
const suite=new ServiceImageTestsAcceptance();
test("acceptance: built image preparer loads verified native OCI bytes without starting resources", suite.program.bind(suite), 120000);

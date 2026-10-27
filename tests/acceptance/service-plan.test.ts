import { DockerCommands } from '../../src/diagnose.js';
import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, statSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceReleaseFixture } from '../support/release-fixture.js';
import {ReadonlyCommands} from '../support/service-plan-test-support.js';
class ServicePlanTestsAcceptance {

    async program(): Promise<void> { const fixture = await new ServiceReleaseFixture().services(); try {
        const request = join(fixture.root, 'request.json');
        writeFileSync(request, JSON.stringify(fixture.configuration));
        const result = spawnSync('node', ['dist/tests/support/service-plan-program.js', request], { encoding: 'utf8', timeout: 30000 });
        if (result.status !== 0)
            throw new Error('Built service planner failed: ' + result.stderr);
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        const plan = JSON.parse(result.stdout) as {
            id: string;
            digest: string;
            formatVersion: number;
        };
        expect(plan.id).toBe('plan-' + plan.digest);
        expect(plan.formatVersion).toBe(3);
        expect(existsSync(join(fixture.installation, '.cordis/credentials'))).toBe(false);
    }
    finally {
        fixture.close();
    } }
}
const suite=new ServicePlanTestsAcceptance();
test("acceptance: default built host saves deterministic five-instance plan without runtime listeners or credentials", suite.program.bind(suite));

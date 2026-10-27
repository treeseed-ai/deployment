import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { ComposeDeploymentHost, ServiceExecution } from '../../src/diagnose.js';
import { ServiceReleaseFixture } from '../support/release-fixture.js';
import { ServiceRuntimeFixture } from '../support/service-runtime-fixture.js';
import {EngineTests} from '../support/service-engine-test-support.js';
class EngineTestsAcceptance extends EngineTests {

    async program(): Promise<void> { const fixture = new ServiceRuntimeFixture(); try {
        await fixture.running();
        const file = join(fixture.root, 'input.json');
        writeFileSync(file, JSON.stringify(fixture.configuration));
        const result = spawnSync('node', ['dist/tests/support/service-engine-program.js', file], { encoding: 'utf8', timeout: 180000 });
        if (result.status !== 0)
            throw new Error(result.stderr);
        const report = JSON.parse(result.stdout);
        expect(report.fixtureOnly).toBe(true);
        expect(report.ready).toBe(false);
        expect(new Set(report.identities.map(EngineTests.service)).size).toBe(5);
        expect(new Set(report.identities.map(EngineTests.resource)).size).toBe(5);
        expect(report.resources.filter(EngineTests.container)).toHaveLength(5);
        expect(report.resources.filter(EngineTests.volume)).toHaveLength(5);
        expect(report.resources.filter(EngineTests.network)).toHaveLength(1);
        expect(report.resources.filter(EngineTests.secret)).toHaveLength(15);
    }
    finally {
        fixture.close();
    } }
}
const suite=new EngineTestsAcceptance();
test("acceptance: built bounded engine starts five disposable instances with exact private mounts and stable receipts", suite.program.bind(suite), 240000);

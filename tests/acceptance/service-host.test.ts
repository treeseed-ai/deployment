import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceReleaseFixture } from '../support/release-fixture.js';
import { ServiceRuntimeFixture } from '../support/service-runtime-fixture.js';
class HostTests {
    async alias(): Promise<void> { const fixture = new ServiceRuntimeFixture(); try {
        await fixture.services();
        const input = join(fixture.root, 'alias-input.json');
        writeFileSync(input, JSON.stringify(fixture.configuration));
        const result = spawnSync('node', ['dist/tests/support/service-host-program.js', input, 'alias-check'], { encoding: 'utf8', timeout: 30000 });
        if (result.status !== 0)
            throw new Error(result.stderr);
        const report = JSON.parse(result.stdout);
        expect(report.refused).toBe(true);
        expect(report.acceptedApplications).toBe(0);
    }
    finally {
        fixture.close();
    } }
    async partial(): Promise<void> {
        const fixture = new ServiceRuntimeFixture();
        try {
            await fixture.services();
            const file = join(fixture.root, 'partial-input.json');
            writeFileSync(file, JSON.stringify(fixture.configuration));
            const result = spawnSync('node', ['dist/tests/support/service-host-program.js', file, 'partial-start'], { encoding: 'utf8', timeout: 30000 });
            if (result.status !== 0)
                throw new Error(result.stderr);
            const report = JSON.parse(result.stdout);
            expect(report.refused).toBe(true);
            expect(report.observerClosed).toBe(true);
            expect(report.foreignPreserved).toBe(true);
        }
        finally {
            fixture.close();
        }
    }
    async program(): Promise<void> {
        const fixture = new ServiceRuntimeFixture();
        try {
            await fixture.running();
            const input = join(fixture.root, 'host-input.json');
            writeFileSync(input, JSON.stringify(fixture.configuration));
            const result = spawnSync('node', ['dist/tests/support/service-host-program.js', input], { encoding: 'utf8', timeout: 180000 });
            if (result.status !== 0)
                throw new Error(result.stderr);
            const report = JSON.parse(result.stdout);
            expect(report.fixtureOnly).toBe(true);
            expect(report.ready).toBe(true);
            expect(report.observerRefused).toBe(true);
            expect(report.closed).toBe(true);
            expect(report.applicationId).toMatch(/^app-[a-f0-9]{64}$/);
        }
        finally {
            fixture.close();
        }
    }
}
const suite = new HostTests();
test("acceptance: native private host separates observer and owner RPC with durable readback and identity-safe close", suite.program.bind(suite), 240000);
test("acceptance: failed host endpoint initialization closes its known listener and preserves foreign state", suite.partial.bind(suite), 60000);
test("acceptance: linked owner endpoint cannot mutate through the observer pathname", suite.alias.bind(suite), 60000);

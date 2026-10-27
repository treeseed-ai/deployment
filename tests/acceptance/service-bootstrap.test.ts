import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceRuntimeFixture } from '../support/service-runtime-fixture.js';
class BootstrapTests {
    async programs(): Promise<void> { for (const mode of ['normal', 'interrupted', 'wrong-nonce']) {
        const fixture = new ServiceRuntimeFixture();
        try {
            await fixture.services();
            const input = join(fixture.root, 'bootstrap-input.json');
            writeFileSync(input, JSON.stringify(fixture.configuration));
            const result = spawnSync('node', ['dist/tests/support/service-bootstrap-program.js', input, mode], { encoding: 'utf8', timeout: 30000 });
            if (result.status !== 0)
                throw new Error(result.stderr);
            const report = JSON.parse(result.stdout);
            expect(report.fixtureOnly).toBe(true);
            if (mode === 'normal') {
                expect(report.writerTransferred).toBe(true);
                expect(report.ready).toBe(false);
            }
            else if (mode === 'interrupted')
                expect(report.adopted).toBe(false);
            else
                expect(report.wrongNonceRefused).toBe(true);
        }
        finally {
            fixture.close();
        }
    } }
}
const suite = new BootstrapTests();
test("acceptance: explicit bootstrap handoff binds the selected child and fences interrupted or mismatched claims", suite.programs.bind(suite), 120000);

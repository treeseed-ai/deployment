import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceRuntimeFixture } from './service-runtime-fixture.js';
class InstalledHostTests {
    async program(): Promise<void> { for (const mode of ['running', 'script']) {
        const fixture = new ServiceRuntimeFixture();
        try {
            if (mode === 'running') await fixture.running(); else await fixture.services();
            const file = join(fixture.root, 'installed-input.json');
            writeFileSync(file, JSON.stringify(fixture.configuration));
            const result = spawnSync('node', ['dist/tests/service-installed-program.js', file, mode], { encoding: 'utf8', timeout: 180000 });
            if (result.status !== 0) throw new Error(result.stderr);
            const report = JSON.parse(result.stdout);
            expect(report.fixtureOnly).toBe(true);
            if (mode === 'running') {
                expect(report.ready).toBe(true);
                expect(report.sameApplication).toBe(true);
                expect(report.noRestart).toBe(true);
                expect(report.services).toBe(5);
            } else expect(report.scriptRefused).toBe(true);
        } finally { fixture.close(); }
    } }
}
const suite = new InstalledHostTests();
test('smoke: default public host launches only pinned native worker and recovers after compiled caller exits', suite.program.bind(suite), 240000);

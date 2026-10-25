import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceRuntimeFixture } from './service-runtime-fixture.js';
class StandaloneWorkerTests {
    async program(): Promise<void> {
        const fixture = new ServiceRuntimeFixture();
        try {
            await fixture.running();
            const file = join(fixture.root, 'standalone-input.json');
            writeFileSync(file, JSON.stringify(fixture.configuration));
            const child = spawnSync('node', ['dist/tests/service-worker-program.js', file], { encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024 });
            if (child.status !== 0) throw new Error(child.stderr);
            const report = JSON.parse(child.stdout);
            expect(report.fixtureOnly).toBe(true);
            expect(report.standalone).toBe(true);
            expect(report.ready).toBe(true);
            expect(report.services).toBe(5);
            expect(report.resourcesRetained).toBe(true);
            expect(report.replayed).toBe(true);
            expect(report.writerReleased).toBe(true);
        } finally { fixture.close(); }
    }
}
const suite = new StandaloneWorkerTests();
test('smoke: genuine compiled worker applies five fixture services with Docker-only PATH and drains privately', suite.program.bind(suite), 240000);

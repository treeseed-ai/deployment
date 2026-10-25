import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceRuntimeFixture } from './service-runtime-fixture.js';
class NativeTests {
    async program(): Promise<void> {
        const fixture = new ServiceRuntimeFixture();
        try {
            await fixture.running(true);
            const file = join(fixture.root, 'native.json');
            writeFileSync(file, JSON.stringify(fixture.configuration));
            const result = spawnSync('node', ['dist/tests/service-native-program.js', file], { encoding: 'utf8', timeout: 180000 });
            if (result.status !== 0)
                throw new Error(result.stderr);
            const report = JSON.parse(result.stdout);
            expect(report.fixtureOnly).toBe(true);
            expect(report.providerScopes).toBe(3);
            expect(report.reports[0].serviceId).toBe('instance-0');
            expect(report.reports[1].serviceId).toBe('instance-1');
            expect(report.reports[0].acknowledgements[0].runtimeGeneration).not.toBe(report.reports[1].acknowledgements[0].runtimeGeneration);
            expect(report.reports[2].observations).toContain('fixture.capabilities-qualified');
            expect(report.history).toContain('probe.invalid-result');
            expect(report.history).toContain('probe.deadline');
            expect(report.history).toContain('probe.pending');
            expect(result.stdout.includes('secret_canary')).toBe(false);
        }
        finally {
            fixture.close();
        }
    }
}
const suite = new NativeTests();
test('smoke: default native archived container and probe scopes qualify distinct disposable instances and drain leases', suite.program.bind(suite), 240000);

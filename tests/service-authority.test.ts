import { test, expect } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ServiceRuntimeFixture } from './service-runtime-fixture.js';
class AuthorityCustodyTests {
    async program(): Promise<void> { const fixture = new ServiceRuntimeFixture(); try {
        await fixture.running(false, true); const input = join(fixture.root, 'authority-custody.json'); writeFileSync(input, JSON.stringify(fixture.configuration));
        const result = spawnSync('node', ['dist/tests/service-authority-program.js', input, fixture.authorityCertificate!], { encoding: 'utf8', timeout: 180000 });
        if (result.status !== 0) throw new Error(result.stderr);
        expect(JSON.parse(result.stdout)).toEqual({ fixtureOnly: true, nativeProbes: true, grants: true, concurrent: true, cancellation: true, privateState: true, sourceFree: true });
    } finally { fixture.close(); } }
}
const suite = new AuthorityCustodyTests();
test('smoke: native public authority custody enforces grants cancellation concurrency private state and source-free reads', suite.program.bind(suite), 240000);

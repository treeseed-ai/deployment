import { test, expect } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ServiceRuntimeFixture } from './service-runtime-fixture.js';
class AuthorityCustodyTests {
    async failed():Promise<void>{await this.run(true);}
    async program(): Promise<void> {await this.run(false);}
    private async run(fenced:boolean):Promise<void> { const fixture = new ServiceRuntimeFixture(); try {
        await fixture.running(false, true); const input = join(fixture.root, 'authority-custody.json'); writeFileSync(input, JSON.stringify(fixture.configuration));
        const result = spawnSync('node', ['dist/tests/service-authority-program.js', input, fixture.authorityCertificate!,fenced?'fenced':'normal'], { encoding: 'utf8', timeout: 180000 });
        if (result.status !== 0) throw new Error(result.stderr);
        expect(JSON.parse(result.stdout)).toEqual(fenced?{fixtureOnly:true,fenced:true,cachedRefused:true,unchanged:true}:{ fixtureOnly: true, nativeProbes: true, grants: true, concurrent: true, cancellation: true, privateState: true, sourceFree: true });
    } finally { fixture.close(); } }
}
const suite = new AuthorityCustodyTests();
test('smoke: native public authority custody enforces grants cancellation concurrency private state and source-free reads', suite.program.bind(suite), 240000);

test('smoke: held adapters refuse effects and unadmitted cached reads after failure',suite.failed.bind(suite),240000);

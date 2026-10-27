import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PostgresServiceFixture } from '../support/service-postgres-fixture.js';
import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
class PostgresServiceTests {
    async installed(): Promise<void> { const fixture = new PostgresServiceFixture(); try {
        await fixture.prepared(); const input = join(fixture.root, 'postgres.json'); writeFileSync(input, JSON.stringify(fixture.configuration));
        const result = spawnSync('node', ['dist/tests/support/service-postgres-program.js', input], { encoding: 'utf8', timeout: 180000 }); if (result.status !== 0) throw new Error(result.stderr);
        expect(JSON.parse(result.stdout)).toEqual({ fixtureOnly: true, ready: true, instances: 2, distinctState: true, wrongPasswordDenied: true, cancelled: true, inflightCancelled: true, sourceFree: true });
    } finally { fixture.close(); } }
    publicProgram(): void {
        const code = "import {PostgresServicePlugin,PostgresReadinessPlugin} from '@treeseed-cordis/deployment';class Program{static run(){if(PostgresServicePlugin.container.providedContracts[0].contractId!=='storage.postgres'||PostgresReadinessPlugin.probe.schemes[0]!=='tcp')throw new Error('Invalid native descriptors');process.stdout.write('postgres-providers-ok\\n');}}Program.run();";
        const result = spawnSync('node', ['--input-type=module', '-e', code], { encoding: 'utf8' }); expect(result.status).toBe(0); expect(result.stderr).toBe(''); expect(result.stdout).toBe('postgres-providers-ok\n');
    }
}
const postgresServices = new PostgresServiceTests();
test("acceptance: native typed Postgres service and readiness classes are public Node exports", postgresServices.publicProgram.bind(postgresServices));

test("acceptance: default native root applies two genuine renamed Postgres instances with isolated credentials and protocol qualification", postgresServices.installed.bind(postgresServices), 240000);

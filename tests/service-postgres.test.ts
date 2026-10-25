import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
class PostgresServiceTests {
    publicProgram(): void {
        const code = "import {PostgresServicePlugin,PostgresReadinessPlugin} from '@treeseed-cordis/deployment';class Program{static run(){if(PostgresServicePlugin.container.providedContracts[0].contractId!=='storage.postgres'||PostgresReadinessPlugin.probe.schemes[0]!=='tcp')throw new Error('Invalid native descriptors');process.stdout.write('postgres-providers-ok\\n');}}Program.run();";
        const result = spawnSync('node', ['--input-type=module', '-e', code], { encoding: 'utf8' }); expect(result.status).toBe(0); expect(result.stderr).toBe(''); expect(result.stdout).toBe('postgres-providers-ok\n');
    }
}
const postgresServices = new PostgresServiceTests();
test('smoke: native typed Postgres service and readiness classes are public Node exports', postgresServices.publicProgram.bind(postgresServices));

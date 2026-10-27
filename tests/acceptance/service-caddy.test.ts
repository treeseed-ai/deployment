import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CaddyServiceFixture } from '../support/service-caddy-fixture.js';
import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
class CaddyServiceTests {
    async installed(): Promise<void> { const fixture = new CaddyServiceFixture(); try { await fixture.prepared(); const input = join(fixture.root, 'caddy.json'); writeFileSync(input, JSON.stringify(fixture.configuration)); const result = spawnSync('node', ['dist/tests/support/service-caddy-program.js', input], { encoding: 'utf8', timeout: 180000 }); if (result.status !== 0) throw new Error(result.stderr); expect(JSON.parse(result.stdout)).toEqual({ fixtureOnly: true, caddy: true, renamed: true, tlsVerified: true, identityRoute: true, privateCa: true, sourceFree: true, retained: true }); } finally { fixture.close(); } }
    publicProgram(): void { const code = "import {CaddyServicePlugin} from '@treeseed-cordis/deployment';class Program{static run(){if(CaddyServicePlugin.container.providedContracts[0].contractId!=='edge.https'||CaddyServicePlugin.container.resources.authorities[0].id!=='public-ca')throw new Error('Missing typed edge');process.stdout.write('caddy-provider-ok\\n');}}Program.run();"; const result = spawnSync('node', ['--input-type=module', '-e', code], { encoding: 'utf8' }); expect(result.status).toBe(0); expect(result.stderr).toBe(''); expect(result.stdout).toBe('caddy-provider-ok\n'); }
}
const caddyServices = new CaddyServiceTests();
test("acceptance: native Caddy service and authority declaration are public Node exports", caddyServices.publicProgram.bind(caddyServices));

test("acceptance: genuine Caddy provider routes renamed protocol fixtures with verified private CA and retained source-free state", caddyServices.installed.bind(caddyServices), 240000);

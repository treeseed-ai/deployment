import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
class CaddyServiceTests {
    publicProgram(): void { const code = "import {CaddyServicePlugin} from '@treeseed-cordis/deployment';class Program{static run(){if(CaddyServicePlugin.container.providedContracts[0].contractId!=='edge.https'||CaddyServicePlugin.container.resources.authorities[0].id!=='public-ca')throw new Error('Missing typed edge');process.stdout.write('caddy-provider-ok\\n');}}Program.run();"; const result = spawnSync('node', ['--input-type=module', '-e', code], { encoding: 'utf8' }); expect(result.status).toBe(0); expect(result.stderr).toBe(''); expect(result.stdout).toBe('caddy-provider-ok\n'); }
}
const caddyServices = new CaddyServiceTests();
test('smoke: native Caddy service and authority declaration are public Node exports', caddyServices.publicProgram.bind(caddyServices));

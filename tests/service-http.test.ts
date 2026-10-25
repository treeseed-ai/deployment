import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
class HttpProbeTests {
    publicProgram(): void { const result = spawnSync('node', ['--input-type=module', '-e', "import {ServiceHttpClient} from '@treeseed-cordis/deployment';class Program{static run(){if(typeof new ServiceHttpClient().read!=='function')throw new Error('Missing transport');process.stdout.write('probe-http-ok\\n');}}Program.run();"], { encoding: 'utf8' }); expect(result.status).toBe(0); expect(result.stderr).toBe(''); expect(result.stdout).toBe('probe-http-ok\n'); }
}
const httpProbes = new HttpProbeTests();
test('smoke: bounded HTTP probe transport is a public Node consumer contract', httpProbes.publicProgram.bind(httpProbes));

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceRuntimeFixture } from './service-runtime-fixture.js';
import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
class HttpProbeTests {
    private static openssl(args: string[]): void { const result = spawnSync('openssl', args, { encoding: 'utf8', timeout: 15000 }); if (result.status !== 0) throw new Error('OpenSSL fixture prerequisite failed'); }
    program(): void { const fixture = new ServiceRuntimeFixture(); try {
        const ca = fixture.publicAuthority(), root = fixture.root, key = join(root, 'server-key.pem'), cert = join(root, 'server.crt'), csr = join(root, 'server.csr'), ext = join(root, 'server.ext'), wrongCa = join(root, 'wrong-ca.crt');
        HttpProbeTests.openssl(['req', '-new', '-newkey', 'rsa:2048', '-noenc', '-subj', '/CN=localhost', '-keyout', key, '-out', csr]); writeFileSync(ext, 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n');
        HttpProbeTests.openssl(['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', join(root, 'public-authority/fixture-key.pem'), '-CAcreateserial', '-days', '1', '-extfile', ext, '-out', cert]);
        HttpProbeTests.openssl(['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-days', '1', '-subj', '/CN=Wrong fixture authority', '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', join(root, 'wrong-key.pem'), '-out', wrongCa]);
        const input = join(root, 'probe-http.json'); writeFileSync(input, JSON.stringify({ ca, key, cert, wrongCa })); const result = spawnSync('node', ['dist/tests/service-http-program.js', input], { encoding: 'utf8', timeout: 30000 }); if (result.status !== 0) throw new Error(result.stderr);
        expect(JSON.parse(result.stdout)).toEqual({ fixtureOnly: true, http: true, verifiedTls: true, wrongTrustDenied: true, malformedDenied: true, abortDrained: true }); expect(result.stdout + result.stderr).not.toContain('SECRET_CANARY');
    } finally { fixture.close(); } }
    publicProgram(): void { const result = spawnSync('node', ['--input-type=module', '-e', "import {ServiceHttpClient} from '@treeseed-cordis/deployment';class Program{static run(){if(typeof new ServiceHttpClient().read!=='function')throw new Error('Missing transport');process.stdout.write('probe-http-ok\\n');}}Program.run();"], { encoding: 'utf8' }); expect(result.status).toBe(0); expect(result.stderr).toBe(''); expect(result.stdout).toBe('probe-http-ok\n'); }
}
const httpProbes = new HttpProbeTests();
test('smoke: bounded HTTP probe transport is a public Node consumer contract', httpProbes.publicProgram.bind(httpProbes));

test('smoke: built probe HTTP transport verifies private CA hostname bounds cancellation and socket drain', httpProbes.program.bind(httpProbes), 45000);

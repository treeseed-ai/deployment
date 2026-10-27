import { test, expect } from 'bun:test';
import { Header } from 'tar';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ServiceRuntimeFixture } from '../support/service-runtime-fixture.js';
import {AuthorityExportTests} from '../support/service-export-test-support.js';
class AuthorityExportTestsAcceptance extends AuthorityExportTests {

    program(): void { const fixture = new ServiceRuntimeFixture(); try {
        const certificate = readFileSync(fixture.publicAuthority()), file = join(fixture.root, 'public-ca.tar'); writeFileSync(file, this.archive('root.crt', certificate));
        const code = "import {AuthorityArchive} from '@treeseed-cordis/deployment';import {readFileSync} from 'node:fs';import {X509Certificate} from 'node:crypto';class Program{static async run(){const bytes=await AuthorityArchive.read(readFileSync(process.argv[1]),'root.crt');if(!new X509Certificate(bytes).ca)throw new Error('Not a CA');process.stdout.write('authority-archive-ok\\n');}}await Program.run();";
        const result = spawnSync('node', ['--input-type=module', '-e', code, file], { encoding: 'utf8' });
        expect(result.status).toBe(0); expect(result.stderr).toBe(''); expect(result.stdout).toBe('authority-archive-ok\n');
    } finally { fixture.close(); } }

    async container(): Promise<void> { const fixture = new ServiceRuntimeFixture(); try {
        await fixture.running(false, true);
        const input = join(fixture.root, 'authority-input.json'); writeFileSync(input, JSON.stringify(fixture.configuration));
        const result = spawnSync('node', ['dist/tests/support/service-export-program.js', input, fixture.authorityCertificate!], { encoding: 'utf8', timeout: 180000 });
        if (result.status !== 0) throw new Error(result.stderr);
        const report = JSON.parse(result.stdout); expect(report.fixtureOnly).toBe(true); expect(report.publicCa).toBe(true); expect(report.readOnly).toBe(true);
    } finally { fixture.close(); } }
}
const suite=new AuthorityExportTestsAcceptance();
test("acceptance: public authority archive reader runs as a Node consumer without extraction", suite.program.bind(suite));
test("acceptance: bounded Docker archive transport reads a public CA from a genuine owned fixture volume", suite.container.bind(suite), 240000);

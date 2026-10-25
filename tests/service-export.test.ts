import { test, expect } from 'bun:test';
import { Header } from 'tar';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ServiceRuntimeFixture } from './service-runtime-fixture.js';
class AuthorityExportTests {
    private archive(path: string, data: Buffer, type: 'File' | 'SymbolicLink' = 'File'): Buffer { const header = Buffer.alloc(512); new Header({ path, type, size: type === 'File' ? data.length : 0, mode: 0o644, linkpath: type === 'SymbolicLink' ? 'private-key.pem' : undefined }).encode(header); return Buffer.concat([header, type === 'File' ? data : Buffer.alloc(0), Buffer.alloc(type === 'File' ? (512 - data.length % 512) % 512 : 0), Buffer.alloc(1024)]); }
    program(): void { const fixture = new ServiceRuntimeFixture(); try {
        const certificate = readFileSync(fixture.publicAuthority()), file = join(fixture.root, 'public-ca.tar'); writeFileSync(file, this.archive('root.crt', certificate));
        const code = "import {AuthorityArchive} from '@treeseed-cordis/deployment';import {readFileSync} from 'node:fs';import {X509Certificate} from 'node:crypto';class Program{static async run(){const bytes=await AuthorityArchive.read(readFileSync(process.argv[1]),'root.crt');if(!new X509Certificate(bytes).ca)throw new Error('Not a CA');process.stdout.write('authority-archive-ok\\n');}}await Program.run();";
        const result = spawnSync('node', ['--input-type=module', '-e', code, file], { encoding: 'utf8' });
        expect(result.status).toBe(0); expect(result.stderr).toBe(''); expect(result.stdout).toBe('authority-archive-ok\n');
    } finally { fixture.close(); } }
    async rejected(): Promise<void> { const { AuthorityArchive } = await import('../src/service-export.js'), fixture = new ServiceRuntimeFixture(); try {
        const certificate = readFileSync(fixture.publicAuthority()), valid = this.archive('root.crt', certificate);
        expect(Buffer.from(await AuthorityArchive.read(valid, 'root.crt')).equals(certificate)).toBe(true);
        for (const bytes of [this.archive('../root.crt', certificate), this.archive('root.crt', Buffer.alloc(0), 'SymbolicLink'), Buffer.concat([valid.subarray(0, valid.length - 1024), valid]), this.archive('root.crt', Buffer.alloc(128 * 1024 + 1)), Buffer.alloc(1024 * 1024 + 1), this.archive('root.crt', Buffer.concat([certificate, Buffer.from('-----BEGIN PRIVATE KEY-----\nSECRET_CANARY\n-----END PRIVATE KEY-----\n')])), valid.subarray(0, 520)]) {
            let rejected = false;
            try { await AuthorityArchive.read(bytes, 'root.crt'); } catch (error) { rejected = true; expect(String(error)).not.toContain('SECRET_CANARY'); }
            expect(rejected).toBe(true);
        }
    } finally { fixture.close(); } }
    async container(): Promise<void> { const fixture = new ServiceRuntimeFixture(); try {
        await fixture.running(false, true);
        const input = join(fixture.root, 'authority-input.json'); writeFileSync(input, JSON.stringify(fixture.configuration));
        const result = spawnSync('node', ['dist/tests/service-export-program.js', input, fixture.authorityCertificate!], { encoding: 'utf8', timeout: 180000 });
        if (result.status !== 0) throw new Error(result.stderr);
        const report = JSON.parse(result.stdout); expect(report.fixtureOnly).toBe(true); expect(report.publicCa).toBe(true); expect(report.readOnly).toBe(true);
    } finally { fixture.close(); } }
}
const suite = new AuthorityExportTests();
test('smoke: public authority archive reader runs as a Node consumer without extraction', suite.program.bind(suite));
test('unit: authority archive rejects links traversal duplicate oversize truncated and private material', suite.rejected.bind(suite));
test('smoke: bounded Docker archive transport reads a public CA from a genuine owned fixture volume', suite.container.bind(suite), 240000);

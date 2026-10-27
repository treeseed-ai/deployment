import { test, expect } from 'bun:test';
import { Header } from 'tar';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ServiceRuntimeFixture } from '../support/service-runtime-fixture.js';
import {AuthorityExportTests} from '../support/service-export-test-support.js';
class AuthorityExportTestsUnit extends AuthorityExportTests {

    async rejected(): Promise<void> { const { AuthorityArchive } = await import('../../src/service-export.js'), fixture = new ServiceRuntimeFixture(); try {
        const certificate = readFileSync(fixture.publicAuthority()), valid = this.archive('root.crt', certificate);
        expect(Buffer.from(await AuthorityArchive.read(valid, 'root.crt')).equals(certificate)).toBe(true);
        for (const bytes of [this.archive('../root.crt', certificate), this.archive('root.crt', Buffer.alloc(0), 'SymbolicLink'), Buffer.concat([valid.subarray(0, valid.length - 1024), valid]), this.archive('root.crt', Buffer.alloc(128 * 1024 + 1)), Buffer.alloc(1024 * 1024 + 1), this.archive('root.crt', Buffer.concat([certificate, Buffer.from('-----BEGIN PRIVATE KEY-----\nSECRET_CANARY\n-----END PRIVATE KEY-----\n')])), valid.subarray(0, 520)]) {
            let rejected = false;
            try { await AuthorityArchive.read(bytes, 'root.crt'); } catch (error) { rejected = true; expect(String(error)).not.toContain('SECRET_CANARY'); }
            expect(rejected).toBe(true);
        }
    } finally { fixture.close(); } }
}
const suite=new AuthorityExportTestsUnit();
test('unit: authority archive rejects links traversal duplicate oversize truncated and private material', suite.rejected.bind(suite));

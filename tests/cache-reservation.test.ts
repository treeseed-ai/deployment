import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, realpathSync, chmodSync, readFileSync, writeFileSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { create } from 'tar';
import { CanonicalJson } from '@treeseed-cordis/sdk';
import { ServiceReleaseFixture } from './release-fixture.js';
class CacheReservationTests {
    private static sha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
    async release(): Promise<void> { await this.program('release'); }
    async helper(): Promise<void> { await this.program('helper'); }
    private async program(mode: string): Promise<void> { const fixture = await new ServiceReleaseFixture().services(); try {
        const helper = join(fixture.root, 'helper');
        mkdirSync(helper, { mode: 0o700 });
        copyFileSync(realpathSync(process.execPath), join(helper, 'bun'));
        chmodSync(join(helper, 'bun'), 0o500);
        const archive = join(fixture.bundle, 'bun.tgz');
        await create({ cwd: helper, file: archive, gzip: true, portable: false }, ['bun']);
        const bytes = readFileSync(archive);
        fixture.release.helpers = { formatVersion: 1, releaseIdentity: 'a'.repeat(64), helpers: [{ id: 'bun', version: '1.4.4', platform: 'linux-amd64', path: 'bun.tgz', sha256: CacheReservationTests.sha(bytes), size: bytes.length, entry: 'bun', files: [{ path: 'bun', sha256: CacheReservationTests.sha(readFileSync(join(helper, 'bun'))), mode: 0o500 }], libraryDirectories: [] }] };
        fixture.release.helpers.releaseIdentity = CanonicalJson.digest({ formatVersion: 1, helpers: fixture.release.helpers.helpers });
        fixture.refreshService();
        const input = join(fixture.root, 'cache-race.json');
        writeFileSync(input, JSON.stringify(fixture.configuration));
        const result = spawnSync('node', ['dist/tests/cache-reservation-program.js', input, mode], { encoding: 'utf8', timeout: 60000 });
        if (result.status !== 0)
            throw new Error(result.stderr);
        expect(JSON.parse(result.stdout)).toEqual({ fixture: true, mode, refused: true, foreignInodePreserved: true, noRuntimeEffects: true });
    }
    finally {
        this.writable(fixture.root);
        fixture.close();
    } }
    private writable(path: string): void { const stat = lstatSync(path); if (stat.isSymbolicLink())
        return; if (stat.isDirectory()) {
        chmodSync(path, 0o700);
        for (const name of readdirSync(path))
            this.writable(join(path, name));
    }
    else
        chmodSync(path, 0o600); }
}
const suite = new CacheReservationTests();
test('smoke: built retained-release custody preserves a foreign empty destination inserted at publication', suite.release.bind(suite), 90000);
test('smoke: built managed-helper custody preserves a foreign empty destination inserted at publication', suite.helper.bind(suite), 90000);

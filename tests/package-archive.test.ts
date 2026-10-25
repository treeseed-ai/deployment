import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { create } from 'tar';
import { ServiceReleaseFixture, PreparedReleaseFixture } from './release-fixture.js';
class PackageArchiveTests {
    async program(): Promise<void> { const fixture = await new ServiceReleaseFixture().services(); try {
        const file = join(fixture.bundle, 'archives/plugin.tgz'), hash = PreparedReleaseFixture.sha(readFileSync(file)), entry = PreparedReleaseFixture.sha(readFileSync(join(fixture.root, 'plugin/package/index.js'))), code = "import {PackageArchiveInspector} from '@treeseed-cordis/deployment';class Program{static entry(value){return value.path==='index.js';}static async run(){const index=await PackageArchiveInspector.inspect(process.argv[1],process.argv[2]),entry=index.files.find(Program.entry);if(index.metadata.name!=='@fixture/plugin'||entry?.sha256!==process.argv[3]||entry.size<1||!Object.isFrozen(index.files))throw new Error('Invalid archive index');process.stdout.write('package-archive-index-ok\\n');}}await Program.run();";
        const result = spawnSync('node', ['--input-type=module', '-e', code, file, hash, entry], { encoding: 'utf8' }); expect(result.status).toBe(0); expect(result.stderr).toBe(''); expect(result.stdout).toBe('package-archive-index-ok\n');
        expect(fixture.installation).toBeTruthy(); const { existsSync } = await import('node:fs'); expect(existsSync(fixture.installation)).toBe(false); expect(existsSync(join(fixture.root, 'SCRIPT_CANARY'))).toBe(false);
    } finally { fixture.close(); } }
    async denied(): Promise<void> { const { PackageArchiveInspector } = await import('../src/package-archive.js'), fixture = await new ServiceReleaseFixture().services(); try {
        const file = join(fixture.bundle, 'archives/plugin.tgz'), hash = PreparedReleaseFixture.sha(readFileSync(file)), link = join(fixture.root, 'linked.tgz'); symlinkSync(file, link);
        for (const [path, digest] of [[file, 'a'.repeat(64)], [link, hash], [join(fixture.root, '..', 'SECRET_CANARY.tgz'), hash]]) { let failed = false; try { await PackageArchiveInspector.inspect(path!, digest!); } catch (error) { failed = true; expect(String(error)).not.toContain('SECRET_CANARY'); } expect(failed).toBe(true); }
        writeFileSync(join(fixture.root, 'plugin/package/oversize.bin'), Buffer.alloc(8 * 1024 * 1024 + 1, 65)); await create({ cwd: join(fixture.root, 'plugin'), file, gzip: true, portable: true }, ['package']); await expect(PackageArchiveInspector.inspect(file, PreparedReleaseFixture.sha(readFileSync(file)))).rejects.toThrow();
    } finally { fixture.close(); } }
}
const packageArchives = new PackageArchiveTests();
test('smoke: public Node package archive inspection hashes genuine files without imports or store effects', packageArchives.program.bind(packageArchives));
test('unit: package archive inspection rejects changed symlink unsafe and oversized sources', packageArchives.denied.bind(packageArchives));

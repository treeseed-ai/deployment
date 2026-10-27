import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, symlinkSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { create } from 'tar';
import { ServiceReleaseFixture, PreparedReleaseFixture } from '../support/release-fixture.js';
class PackageArchiveTestsIntegration {

    async denied(): Promise<void> { const { PackageArchiveInspector } = await import('../../src/package-archive.js'), fixture = await new ServiceReleaseFixture().services(); try {
        const file = join(fixture.bundle, 'archives/plugin.tgz'), hash = PreparedReleaseFixture.sha(readFileSync(file)), link = join(fixture.root, 'linked.tgz'); symlinkSync(file, link);
        for (const [path, digest] of [[file, 'a'.repeat(64)], [link, hash], [fixture.root + '/../SECRET_CANARY.tgz', hash]]) { let failed = false; try { await PackageArchiveInspector.inspect(path!, digest!); } catch (error) { failed = true; expect(String(error)).not.toContain('SECRET_CANARY'); } expect(failed).toBe(true); }
        const pending = PackageArchiveInspector.inspect(file, hash), held = file + '.held'; renameSync(file, held); writeFileSync(file, readFileSync(held)); await expect(pending).rejects.toThrow();
        writeFileSync(join(fixture.root, 'plugin/package/oversize.bin'), Buffer.alloc(8 * 1024 * 1024 + 1, 65)); await create({ cwd: join(fixture.root, 'plugin'), file, gzip: true, portable: true }, ['package']); await expect(PackageArchiveInspector.inspect(file, PreparedReleaseFixture.sha(readFileSync(file)))).rejects.toThrow();
    } finally { fixture.close(); } }
}
const packageArchives=new PackageArchiveTestsIntegration();
test("integration: package archive inspection rejects changed symlink unsafe and oversized sources", packageArchives.denied.bind(packageArchives));

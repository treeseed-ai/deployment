import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { create } from 'tar';
import { ServiceReleaseFixture } from './release-fixture.js';
import { ComposeDeploymentHost, ServicePlanStore, ServiceProviderStager } from '../../src/diagnose.js';
export class ServiceStagingTests {

    protected static async archive(fixture: ServiceReleaseFixture, id: string, value: string): Promise<{
        name: string;
        version: string;
        path: string;
        sha256: string;
    }> { const root = join(fixture.root, id); mkdirSync(join(root, 'package'), { recursive: true }); writeFileSync(join(root, 'entry.ts'), 'export class Ordinary {value():string{return ' + JSON.stringify(value) + ';}}'); const built = spawnSync('bun', ['build', join(root, 'entry.ts'), '--target=node', '--outfile', join(root, 'package/index.js')], { encoding: 'utf8' }); if (built.status !== 0)
        throw new Error(built.stderr); writeFileSync(join(root, 'package/package.json'), JSON.stringify({ name: '@fixture/' + id, version: '1.0.0', type: 'module', exports: './index.js' })); const path = 'archives/' + id + '.tgz'; await create({ cwd: root, file: join(fixture.bundle, path), gzip: true, portable: true }, ['package']); return { name: '@fixture/' + id, version: '1.0.0', path, sha256: ServiceReleaseFixture.sha(readFileSync(join(fixture.bundle, path))) }; }
}

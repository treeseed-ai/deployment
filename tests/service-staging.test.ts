import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { create } from 'tar';
import { ServiceReleaseFixture } from './release-fixture.js';
import { ComposeDeploymentHost, ServicePlanStore, ServiceProviderStager } from '../src/diagnose.js';
class ServiceStagingTests {
    async reservedPath():Promise<void>{const fixture=await new ServiceReleaseFixture().services();try{writeFileSync(join(fixture.root,'plugin/package/manifest.json'),'{}');await fixture.saveMetadata(JSON.parse(readFileSync(join(fixture.root,'plugin/package/package.json'),'utf8')));const plan=await new ComposeDeploymentHost().plan(fixture.configuration);if(plan.formatVersion!==3)throw new Error('Wrong format');const store=new ServicePlanStore(fixture.installation),writer=store.writer();try{const record=store.accept({protocol:3,operation:'submit',planId:plan.id,digest:plan.digest,idempotencyKey:'reserved-path'},writer).record;store.append({...record,sequence:1,phase:'stage',result:null},writer);await expect(new ServiceProviderStager(plan).stage('instance-0','container',writer)).rejects.toThrow();expect(existsSync(join(fixture.installation,'.cordis/artifacts'))).toBe(false);}finally{writer.close();}}finally{fixture.close();}}

    private static async archive(fixture: ServiceReleaseFixture, id: string, value: string): Promise<{
        name: string;
        version: string;
        path: string;
        sha256: string;
    }> { const root = join(fixture.root, id); mkdirSync(join(root, 'package'), { recursive: true }); writeFileSync(join(root, 'entry.ts'), 'export class Ordinary {value():string{return ' + JSON.stringify(value) + ';}}'); const built = spawnSync('bun', ['build', join(root, 'entry.ts'), '--target=node', '--outfile', join(root, 'package/index.js')], { encoding: 'utf8' }); if (built.status !== 0)
        throw new Error(built.stderr); writeFileSync(join(root, 'package/package.json'), JSON.stringify({ name: '@fixture/' + id, version: '1.0.0', type: 'module', exports: './index.js' })); const path = 'archives/' + id + '.tgz'; await create({ cwd: root, file: join(fixture.bundle, path), gzip: true, portable: true }, ['package']); return { name: '@fixture/' + id, version: '1.0.0', path, sha256: ServiceReleaseFixture.sha(readFileSync(join(fixture.bundle, path))) }; }
    async closure(): Promise<void> { const fixture = await new ServiceReleaseFixture().services(); try {
        const ordinary = await ServiceStagingTests.archive(fixture, 'ordinary', 'one'), unrelated = await ServiceStagingTests.archive(fixture, 'unrelated', 'first');
        fixture.release.packages.push(ordinary, unrelated);
        const root = JSON.parse(readFileSync(join(fixture.bundle, 'package.json'), 'utf8'));
        root.dependencies[ordinary.name] = 'file:' + ordinary.path;
        root.dependencies[unrelated.name] = 'file:' + unrelated.path;
        fixture.release.packageJson.sha256 = fixture.write('package.json', root);
        const metadata = JSON.parse(readFileSync(join(fixture.root, 'plugin/package/package.json'), 'utf8'));
        metadata.peerDependencies = { [ordinary.name]: '1.0.0' };
        await fixture.saveMetadata(metadata);
        const host = new ComposeDeploymentHost(), first = await host.plan(fixture.configuration);
        if (first.formatVersion !== 3)
            throw new Error('Wrong format');
        const store = new ServicePlanStore(fixture.installation);
        let writer = store.writer(), digest = '';
        try {
            const accepted = store.accept({ protocol: 3, operation: 'submit', planId: first.id, digest: first.digest, idempotencyKey: 'closure-first' }, writer).record, staged = { ...accepted, sequence: 1, phase: 'stage' as const, result: null };
            store.append(staged, writer);
            const prepared = await new ServiceProviderStager(first).stage('instance-0', 'container', writer);
            digest = prepared.digest;
            const manifest = JSON.parse(readFileSync(prepared.file, 'utf8'));
            let dependency = false, extra = false;
            for (const file of manifest.files) {
                if (file.path === 'node_modules/@fixture/ordinary/index.js')
                    dependency = true;
                if (file.path.includes('unrelated'))
                    extra = true;
            }
            expect(dependency).toBe(true);
            expect(extra).toBe(false);
            store.append({ ...staged, sequence: 2, phase: 'failed', result: 'blocked' }, writer);
        }
        finally {
            writer.close();
        }
        const changed = await ServiceStagingTests.archive(fixture, 'unrelated', 'second');
        for (const entry of fixture.release.packages)
            if (entry.name === changed.name)
                entry.sha256 = changed.sha256;
        const lock = spawnSync('bun', ['install', '--lockfile-only', '--force', '--ignore-scripts'], { cwd: fixture.bundle, encoding: 'utf8' });
        if (lock.status !== 0)
            throw new Error(lock.stderr);
        fixture.release.lockfile.sha256 = ServiceReleaseFixture.sha(readFileSync(join(fixture.bundle, 'bun.lock')));
        fixture.refreshService();
        const second = await host.plan(fixture.configuration);
        if (second.formatVersion !== 3)
            throw new Error('Wrong format');
        expect(second.compositionGeneration).not.toBe(first.compositionGeneration);
        writer = store.writer();
        try {
            const accepted = store.accept({ protocol: 3, operation: 'submit', planId: second.id, digest: second.digest, idempotencyKey: 'closure-second' }, writer).record;
            store.append({ ...accepted, sequence: 1, phase: 'stage', result: null }, writer);
            expect((await new ServiceProviderStager(second).stage('instance-0', 'container', writer)).digest).toBe(digest);
            expect(existsSync(join(fixture.root, 'SCRIPT_CANARY'))).toBe(false);
        }
        finally {
            writer.close();
        }
    }
    finally {
        fixture.close();
    } }
    async program(): Promise<void> { const fixture = await new ServiceReleaseFixture().services(); try {
        const input = join(fixture.root, 'staging-input.json');
        writeFileSync(input, JSON.stringify(fixture.configuration));
        expect(existsSync(join(fixture.root, 'SCRIPT_CANARY'))).toBe(false);
        const result = spawnSync('node', ['dist/tests/service-staging-program.js', input], { encoding: 'utf8', timeout: 30000 });
        if (result.status !== 0)
            throw new Error(result.stderr);
        expect(JSON.parse(result.stdout)).toEqual({ fixtureOnly: true, identities: ['instance-0', 'instance-1'] });
        expect(existsSync(join(fixture.root, 'SCRIPT_CANARY'))).toBe(true);
        const providers = join(fixture.installation, '.cordis/artifacts/providers');
        for (const name of readdirSync(providers)) {
            expect(name).toMatch(/^[a-f0-9]{64}$/);
            expect(statSync(join(providers, name)).mode & 0o777).toBe(0o500);
            const manifest = JSON.parse(readFileSync(join(providers, name, 'manifest.json'), 'utf8'));
            expect(manifest.formatVersion).toBe(2);
            expect(statSync(join(providers, name, 'manifest.json')).mode & 0o777).toBe(0o400);
            for (const entry of manifest.files)
                expect(statSync(join(providers, name, entry.path)).mode & 0o777).toBe(0o400);
        }
        expect(existsSync(join(fixture.installation, '.cordis/credentials'))).toBe(false);
    }
    finally {
        fixture.close();
    } }
    async blocked(): Promise<void> { const fixture = await new ServiceReleaseFixture().services(); try {
        const plan = await new ComposeDeploymentHost().plan(fixture.configuration);
        if (plan.formatVersion !== 3)
            throw new Error('Wrong format');
        const store = new ServicePlanStore(fixture.installation), writer = store.writer();
        try {
            const stager = new ServiceProviderStager(plan);
            await expect(stager.stage('instance-0', 'container', writer)).rejects.toThrow();
            expect(existsSync(join(fixture.installation, '.cordis/artifacts'))).toBe(false);
            const record = store.accept({ protocol: 3, operation: 'submit', planId: plan.id, digest: plan.digest, idempotencyKey: 'stage' }, writer).record;
            store.append({ ...record, sequence: 1, phase: 'stage', result: null }, writer);
            await expect(stager.stage('foreign', 'container', writer)).rejects.toThrow();
            const archive = join(fixture.bundle, fixture.release.packages[0]!.path), bytes = readFileSync(archive);
            writeFileSync(archive, 'tampered');
            await expect(stager.stage('instance-0', 'container', writer)).rejects.toThrow();
            expect(existsSync(join(fixture.installation, '.cordis/artifacts'))).toBe(false);
            writeFileSync(archive, bytes);
            await stager.stage('instance-0', 'container', writer);
            mkdirSync(join(fixture.installation, '.cordis/artifacts/providers/building-uncertain'), { mode: 0o700 });
            await expect(stager.stage('instance-1', 'container', writer)).rejects.toThrow();
            expect(existsSync(join(fixture.root, 'SCRIPT_CANARY'))).toBe(false);
        }
        finally {
            writer.close();
        }
    }
    finally {
        fixture.close();
    } }
}
const suite = new ServiceStagingTests();
test('smoke: built stager loads genuine archive classes through two native Cordis scopes', suite.program.bind(suite), 30000);
test('integration: staging requires accepted scope exact bytes and complete prior state', suite.blocked.bind(suite));
test('integration: provider closure includes locked peers and excludes unrelated bundle changes', suite.closure.bind(suite), 30000);

test('integration: reserved native manifest collisions block before staging creates files',suite.reservedPath.bind(suite));

import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { create } from 'tar';
import { ServiceReleaseFixture } from '../support/release-fixture.js';
import { ComposeDeploymentHost, ServicePlanStore, ServiceProviderStager } from '../../src/diagnose.js';
import {ServiceStagingTests} from '../support/service-staging-test-support.js';
class ServiceStagingTestsIntegration extends ServiceStagingTests {

    async reservedPath():Promise<void>{const fixture=await new ServiceReleaseFixture().services();try{writeFileSync(join(fixture.root,'plugin/package/manifest.json'),'{}');await fixture.saveMetadata(JSON.parse(readFileSync(join(fixture.root,'plugin/package/package.json'),'utf8')));const plan=await new ComposeDeploymentHost().plan(fixture.configuration);if(plan.formatVersion!==3)throw new Error('Wrong format');const store=new ServicePlanStore(fixture.installation),writer=store.writer();try{const record=store.accept({protocol:3,operation:'submit',planId:plan.id,digest:plan.digest,idempotencyKey:'reserved-path'},writer).record;store.append({...record,sequence:1,phase:'stage',result:null},writer);await expect(new ServiceProviderStager(plan).stage('instance-0','container',writer)).rejects.toThrow();expect(existsSync(join(fixture.installation,'.cordis/artifacts'))).toBe(false);}finally{writer.close();}}finally{fixture.close();}}

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
const suite=new ServiceStagingTestsIntegration();
test('integration: staging requires accepted scope exact bytes and complete prior state', suite.blocked.bind(suite));
test('integration: provider closure includes locked peers and excludes unrelated bundle changes', suite.closure.bind(suite), 30000);
test('integration: reserved native manifest collisions block before staging creates files',suite.reservedPath.bind(suite));

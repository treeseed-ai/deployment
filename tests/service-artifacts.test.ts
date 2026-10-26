import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create } from 'tar';
import { PackageDefinition, ProviderV4Schemas, PlatformSchemas, ServiceSchemas, CanonicalJson, PlanningBlockedError, type ServiceInstance, type ServiceRelease } from '@treeseed-cordis/sdk';
import { PreparedReleaseFixture,ServiceReleaseFixture as ServiceFixture } from './release-fixture.js';
import { ContainerFixture, ProbeFixture, SharedStaticContainerFixture, SharedStaticProbeFixture } from './service-fixture-plugins.js';
class ServiceArtifactTests {
    async resolve(): Promise<void> {
        const fixture = await new ServiceFixture().services();
        try {
            const module = await import('../src/service-artifacts.js') as unknown as {
                ServiceArtifactResolver: new () => {
                    resolve(config: unknown): Promise<{
                        inventory: ServiceRelease;
                        artifacts: unknown[];
                    }>;
                };
            };
            const resolved = await new module.ServiceArtifactResolver().resolve(fixture.configuration);
            expect(resolved.inventory.composition.services.length).toBe(5);
            expect(resolved.artifacts.length).toBe(2);
            expect(existsSync(join(fixture.root, 'SCRIPT_CANARY'))).toBe(false);
            expect(existsSync(fixture.installation)).toBe(false);
        }
        finally {
            fixture.close();
        }
    }
    async mismatch(): Promise<void> {
        const fixture = await new ServiceFixture().services();
        try {
            fixture.release.composition.services[4]!.definition.command = ['unexpected'];
            fixture.refreshService();
            const module = await import('../src/service-artifacts.js') as unknown as {
                ServiceArtifactResolver: new () => {
                    resolve(config: unknown): Promise<unknown>;
                };
            };
            await expect(new module.ServiceArtifactResolver().resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);
        }
        finally {
            fixture.close();
        }
    }
}
const suite = new ServiceArtifactTests();
test('integration: exact format3 bundle resolves five instances sharing native container and probe exports without imports or state', suite.resolve.bind(suite));
test('unit: owner container projection cannot be overridden by a service instance', suite.mismatch.bind(suite));
class ServiceArtifactProgramTests {
    async roundtrip(): Promise<void> {
        const fixture = await new ServiceFixture().withCredentials();
        try {
            const file = join(fixture.root, 'canonical-request.json'), archive = readFileSync(join(fixture.bundle, 'archives/plugin.tgz'));
            writeFileSync(file, JSON.stringify(fixture.configuration));
            const code = "import{readFileSync,writeFileSync}from'node:fs';import{createHash}from'node:crypto';import{join}from'node:path';import{CanonicalJson,PlanningBlockedError}from'@treeseed-cordis/sdk';import{ServicePlanIdentity,ServiceArtifactResolver}from'@treeseed-cordis/deployment';class Program{static async run(){const configuration=JSON.parse(readFileSync(process.argv[1],'utf8')),path=join(configuration.release.directory,'release.json'),release=JSON.parse(readFileSync(path,'utf8'));release.composition=ServicePlanIdentity.graph(release.composition);if(process.argv[2]==='changed-target')release.composition.services[0].definition.secrets[0].target='/run/cordis/foreign';const bytes=CanonicalJson.stringify(release)+'\\n';writeFileSync(path,bytes);configuration.release.manifestDigest=createHash('sha256').update(bytes).digest('hex');const input=CanonicalJson.stringify(configuration);try{await new ServiceArtifactResolver().resolve(configuration);}catch(error){if(process.argv[2]==='changed-target'&&error instanceof PlanningBlockedError&&error.blockers[0]?.code==='SERVICE_DEFINITION_MISMATCH'){process.stdout.write('target-refused\\n');return;}throw error;}if(process.argv[2]==='changed-target')throw new Error('Changed secret target accepted');if(readFileSync(path,'utf8')!==bytes||CanonicalJson.stringify(configuration)!==input)throw new Error('Verifier mutated caller input');process.stdout.write('canonical-roundtrip-ok\\n');}}await Program.run();";
            const result = spawnSync('node', ['--input-type=module', '-e', code, file], { encoding: 'utf8', timeout: 15000 });
            if (result.status !== 0) throw new Error(result.stderr);
            expect(result.stdout).toBe('canonical-roundtrip-ok\n');
            const changed = spawnSync('node', ['--input-type=module', '-e', code, file, 'changed-target'], { encoding: 'utf8', timeout: 15000 });
            expect(changed.status).toBe(0); expect(changed.stdout).toBe('target-refused\n');
            expect(readFileSync(join(fixture.bundle, 'archives/plugin.tgz')).equals(archive)).toBe(true);
            expect(existsSync(fixture.installation)).toBe(false); expect(existsSync(join(fixture.root, 'SCRIPT_CANARY'))).toBe(false);
        } finally { fixture.close(); }
    }
    async program(): Promise<void> {
        const fixture = await new ServiceFixture().services();
        try {
            const file = join(fixture.root, 'request.json');
            writeFileSync(file, JSON.stringify(fixture.configuration));
            const code = "import {readFileSync} from 'node:fs';import {ServiceArtifactResolver} from '@treeseed-cordis/deployment';class Program{static async run(){const result=await new ServiceArtifactResolver().resolve(JSON.parse(readFileSync(process.argv[1],'utf8')));process.stdout.write(String(result.inventory.composition.services.length)+'\\n');}}await Program.run();";
            const result = spawnSync('node', ['--input-type=module', '-e', code, file], { encoding: 'utf8', timeout: 10000 });
            expect(result.status).toBe(0);
            expect(result.stdout).toBe('5\n');
            expect(result.stderr).toBe('');
            expect(existsSync(fixture.installation)).toBe(false);
        }
        finally {
            fixture.close();
        }
    }
}
const program = new ServiceArtifactProgramTests();
test('smoke: built public deployment artifact verifies a five-service release as a Node program', program.program.bind(program));
test('smoke: public artifact resolver accepts canonical saved credential graphs and still refuses changed secret targets', program.roundtrip.bind(program));
class ServiceArtifactBoundaryTests {
    async image(): Promise<void> {
        const fixture = await new ServiceFixture().services();
        try {
            const metadata = JSON.parse(readFileSync(join(fixture.root, 'plugin/package/package.json'), 'utf8')) as {
                cordisPackage: {
                    images: unknown[];
                };
            };
            metadata.cordisPackage.images = [];
            await fixture.saveMetadata(metadata);
            const { ServiceArtifactResolver } = await import('../src/service-artifacts.js');
            await expect(new ServiceArtifactResolver().resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);
            expect(existsSync(fixture.installation)).toBe(false);
        }
        finally {
            fixture.close();
        }
    }
    async negative(): Promise<void> {
        const fixture = await new ServiceFixture().services();
        try {
            const { ServiceArtifactResolver } = await import('../src/service-artifacts.js'), resolver = new ServiceArtifactResolver(), service = fixture.release.composition.services[4]!;
            service.configuration = { password: 'secret-output-canary' };
            fixture.refreshService();
            try {
                await resolver.resolve(fixture.configuration);
                throw new Error('accepted');
            }
            catch (error) {
                expect(error).toBeInstanceOf(PlanningBlockedError);
                expect(JSON.stringify(error).includes('secret-output-canary')).toBe(false);
            }
            service.configuration = {};
            service.provider.classExport = 'WrongClass';
            fixture.refreshService();
            await expect(resolver.resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);
            service.provider.classExport = 'ContainerFixture';
            fixture.recipe.services['instance-4']!.image = 'fixture/application:latest';
            fixture.refreshService();
            await expect(resolver.resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);
            fixture.recipe.services['instance-4']!.image = fixture.release.images[0]!.reference;
            fixture.release.composition.assetDigest = 'f'.repeat(64);
            fixture.refreshService();
            await expect(resolver.resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);
            expect(existsSync(fixture.installation)).toBe(false);
            expect(existsSync(join(fixture.root, 'SCRIPT_CANARY'))).toBe(false);
        }
        finally {
            fixture.close();
        }
    }
}
const boundaries = new ServiceArtifactBoundaryTests();
test('unit: a container image must be bound by its owning package projection', boundaries.image.bind(boundaries));
test('integration: service configuration export recipe and asset tampering fail safely without state', boundaries.negative.bind(boundaries));
class ServiceExportCalibrationTests {
    async exports(): Promise<void> { const fixture = await new ServiceFixture().services(); try {
        const entry = join(fixture.root, 'plugin/package/index.js'), code = "import {pathToFileURL} from 'node:url';class Calibration{static async run(){const exports=await import(pathToFileURL(process.argv[1]).href);for(const name of ['ContainerFixture','ProbeFixture'])if(typeof exports[name]!=='function')throw new Error('missing export');process.stdout.write('native-exports-ok\\n');}}await Calibration.run();";
        expect(existsSync(join(fixture.root, 'SCRIPT_CANARY'))).toBe(false);
        const result = spawnSync('node', ['--input-type=module', '-e', code, entry], { encoding: 'utf8', timeout: 10000 });
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toBe('native-exports-ok\n');
        expect(existsSync(join(fixture.root, 'SCRIPT_CANARY'))).toBe(true);
    }
    finally {
        fixture.close();
    } }
}
const calibration = new ServiceExportCalibrationTests();
test('smoke: archive fixture exports the same native classes used for metadata and calibrates the import canary', calibration.exports.bind(calibration));

class PublicFixtureTests {
 program():void{const code="import {ServiceReleaseFixture} from '@treeseed-cordis/deployment/testing';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';class Program{static async run(){const cwd=mkdtempSync(join(tmpdir(),'cordis-consumer-cwd-'));process.chdir(cwd);let fixture;try{fixture=await new ServiceReleaseFixture().services();if(fixture.release.composition.services.length!==5)throw new Error('fixture composition');process.stdout.write('public-fixture-ok\\n');}finally{fixture?.close();rmSync(cwd,{recursive:true,force:true});}}}await Program.run();";const result=spawnSync('node',['--input-type=module','-e',code],{encoding:'utf8'});expect(result.status).toBe(0);expect(result.stderr).toBe('');expect(result.stdout).toBe('public-fixture-ok\n');}
}
const publicFixture=new PublicFixtureTests();test('smoke: public compiled fixture constructs in an unrelated consumer working directory',publicFixture.program.bind(publicFixture));

class ImageCatalogTests {
    private async sharedFixture(runtime = false): Promise<ServiceFixture> {
        const fixture = await new ServiceFixture().services(), source = join(fixture.root, 'shared-image-package'); mkdirSync(source);
        const owner = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './service-fixture-plugins.ts' : './service-fixture-plugins.js', import.meta.url));
        writeFileSync(join(source, 'entry.ts'), 'export{SharedStaticContainerFixture,SharedStaticProbeFixture}from' + JSON.stringify(owner) + ';\n');
        const build = spawnSync('bun', ['build', join(source, 'entry.ts'), '--target=node', '--outfile', join(source, 'index.js')], { encoding: 'utf8' }); if (build.status !== 0) throw new Error('Shared fixture compilation failed');
        const image = fixture.release.images[0]!, descriptor = PackageDefinition.define('@fixture/shared-image', '1.0.0', 'shared-image', [PackageDefinition.export(SharedStaticContainerFixture, 'index.js', 'SharedStaticContainerFixture'), PackageDefinition.export(SharedStaticProbeFixture, 'index.js', 'SharedStaticProbeFixture')], [], runtime ? [] : [{ id: image.id, reference: image.reference, indexSha256: image.indexSha256, manifestDigest: image.manifestDigest, source: { kind: 'prepared' } }], runtime ? [{ id: image.id, entry: 'index.js' }] : undefined);
        writeFileSync(join(source, 'package.json'), JSON.stringify({ name: '@fixture/shared-image', version: '1.0.0', type: 'module', exports: './index.js', cordisPackage: descriptor }));
        await create({ cwd: source, file: join(fixture.bundle, 'archives/shared.tgz'), gzip: true, portable: true, prefix: 'package/' }, ['package.json', 'index.js']);
        const sha256 = PreparedReleaseFixture.sha(readFileSync(join(fixture.bundle, 'archives/shared.tgz'))), service = structuredClone(fixture.release.composition.services[4]!);
        service.serviceId = 'shared-image-instance'; service.provider = { ...service.provider, pluginId: 'shared-image', providerId: 'shared-image.container', package: { name: '@fixture/shared-image', version: '1.0.0', sha256 }, classExport: 'SharedStaticContainerFixture' };
        service.bindings[0]!.bindingId = 'shared-image.http'; service.readiness.provider = { ...service.provider, providerId: 'shared-image.probe', classExport: 'SharedStaticProbeFixture' }; service.readiness.endpoint.serviceId = service.serviceId;
        fixture.release.composition.services.push(service); fixture.release.packages.push({ name: '@fixture/shared-image', version: '1.0.0', path: 'archives/shared.tgz', sha256 }); fixture.configuration.plugins.push({ id: 'shared-image', package: '@fixture/shared-image', version: '1.0.0', integrity: sha256 }); fixture.recipe.services[service.serviceId] = { image: image.reference };
        const root = JSON.parse(readFileSync(join(fixture.bundle, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }; root.dependencies['@fixture/shared-image'] = 'file:archives/shared.tgz'; fixture.release.packageJson.sha256 = fixture.write('package.json', root);
        const lock = spawnSync('bun', ['install', '--lockfile-only', '--force', '--ignore-scripts'], { cwd: fixture.bundle, encoding: 'utf8', env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(fixture.root, 'shared-install-cache') } }); if (lock.status !== 0) throw new Error('Shared fixture lock failed'); fixture.release.lockfile.sha256 = PreparedReleaseFixture.sha(readFileSync(join(fixture.bundle, 'bun.lock'))); fixture.refreshService();
        return fixture;
    }
    private static program(fixture: ServiceFixture, blocked = false): string {
        const file = join(fixture.root, 'shared-request.json'); writeFileSync(file, JSON.stringify(fixture.configuration));
        const code = "import{readFileSync}from'node:fs';import{PlanningBlockedError}from'@treeseed-cordis/sdk';import{ServiceArtifactResolver}from'@treeseed-cordis/deployment';class Program{static async run(){try{const value=await new ServiceArtifactResolver().resolve(JSON.parse(readFileSync(process.argv[1],'utf8')));if(process.argv[2]==='blocked')throw new Error('Conflicting image ownership accepted');process.stdout.write(value.inventory.composition.services.length+':'+value.artifacts.filter(this.image).length+'\\n');}catch(error){if(process.argv[2]==='blocked'&&error instanceof PlanningBlockedError&&error.blockers.some(this.binding)){process.stdout.write('binding-refused\\n');return;}throw error;}}static image(value){return value.kind==='image';}static binding(value){return value.code==='IMAGE_PACKAGE_BINDING';}}await Program.run();";
        const result = spawnSync('node', ['--input-type=module', '-e', code, file, blocked ? 'blocked' : 'valid'], { encoding: 'utf8', timeout: 15000 }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout;
    }
    async shared(): Promise<void> { const fixture = await this.sharedFixture(); try {
        expect(ImageCatalogTests.program(fixture)).toBe('6:1\n'); expect(existsSync(fixture.installation)).toBe(false); expect(existsSync(join(fixture.root, 'SCRIPT_CANARY'))).toBe(false);
        fixture.release.images[0]!.indexSha256 = 'a'.repeat(64); fixture.refreshService(); expect(ImageCatalogTests.program(fixture, true)).toBe('binding-refused\n');
    } finally { fixture.close(); }
        const mixed = await this.sharedFixture(true); try { expect(ImageCatalogTests.program(mixed, true)).toBe('binding-refused\n'); expect(existsSync(mixed.installation)).toBe(false); expect(existsSync(join(mixed.root, 'SCRIPT_CANARY'))).toBe(false); } finally { mixed.close(); }
    }
    async selectedOnly(): Promise<void> { const fixture = await new ServiceFixture().services(); try {
        const metadata = JSON.parse(readFileSync(join(fixture.root, 'plugin/package/package.json'), 'utf8')) as { cordisPackage: { images: Array<{ id: string; reference: string }>; runtimeImages?: Array<{ id: string; entry: string }> } }, image = metadata.cordisPackage.images[0]!;
        metadata.cordisPackage.images.push({ ...image, id: 'unselected-image', reference: image.reference.replace('fixture/application', 'fixture/unselected') }); await fixture.saveMetadata(metadata);
        const { ServiceArtifactResolver } = await import('../src/service-artifacts.js'); expect((await new ServiceArtifactResolver().resolve(fixture.configuration)).inventory.images.length).toBe(1); expect(existsSync(join(fixture.root, 'SCRIPT_CANARY'))).toBe(false);
        metadata.cordisPackage.runtimeImages = [{ id: 'unselected-runtime', entry: 'index.js' }]; await fixture.saveMetadata(metadata); expect((await new ServiceArtifactResolver().resolve(fixture.configuration)).inventory.images.length).toBe(1);
        fixture.release.images.push({ ...fixture.release.images[0]!, id: 'unselected-image', reference: fixture.release.images[0]!.reference.replace('fixture/application', 'fixture/unselected') }); fixture.refreshService(); await expect(new ServiceArtifactResolver().resolve(fixture.configuration)).rejects.toThrow();
    } finally { fixture.close(); } }
}
const imageCatalog = new ImageCatalogTests();
test('integration: unselected package image declarations need no artifacts while unused inventory remains blocked', imageCatalog.selectedOnly.bind(imageCatalog));
test('smoke: public resolver shares exact static images across genuine provider packages and rejects changed pins or runtime ownership', imageCatalog.shared.bind(imageCatalog));

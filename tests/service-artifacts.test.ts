import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { create } from 'tar';
import { PackageDefinition, ProviderV4Schemas, PlatformSchemas, ServiceSchemas, CanonicalJson, PlanningBlockedError, type ServiceInstance, type ServiceRelease } from '@treeseed-cordis/sdk';
import { PreparedReleaseFixture } from './release-fixture.js';
import {ContainerFixture,ProbeFixture} from './service-fixture-plugins.js';
class ServiceFixture extends PreparedReleaseFixture {
    release!: ServiceRelease;
    async services(): Promise<this> {
        await this.prepare();
        const source = join(this.root, 'plugin/package'), image = this.inventory.images[0]!, images = [{ id: image.id, reference: image.reference, manifestDigest: image.manifestDigest, indexSha256: image.indexSha256, source: { kind: 'oci-archive' as const, url: 'https://fixture.invalid/image.tar', sha256: 'a'.repeat(64), size: 1 } }];
        const entry = join(this.root,'provider-entry.ts');writeFileSync(entry,`import {writeFileSync} from 'node:fs';export {ContainerFixture,ProbeFixture} from ${JSON.stringify(join(process.cwd(),'tests/service-fixture-plugins.ts'))};class Canary{static run():void{writeFileSync(${JSON.stringify(join(this.root,'SCRIPT_CANARY'))},'imported');}}Canary.run();`);const build=spawnSync('bun',['build',entry,'--target=node','--outfile',join(source,'index.js')],{encoding:'utf8'});if(build.status!==0)throw new Error('Provider fixture compilation failed');
        const metadata = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as Record<string, unknown>;
        metadata.cordisPackage = PackageDefinition.define('@fixture/plugin', '1.0.0', 'fixture', [PackageDefinition.export(ContainerFixture, 'index.js', 'ContainerFixture'), PackageDefinition.export(ProbeFixture, 'index.js', 'ProbeFixture')], [], images);
        writeFileSync(join(source, 'package.json'), JSON.stringify(metadata));
        await create({ cwd: join(this.root, 'plugin'), file: join(this.bundle, 'archives/plugin.tgz'), gzip: true, portable: true }, ['package']);
        const sha = PreparedReleaseFixture.sha(readFileSync(join(this.bundle, 'archives/plugin.tgz')));
        this.inventory.packages[0]!.sha256 = sha;
        this.configuration.plugins[0]!.integrity = sha;
        const lock = spawnSync('bun', ['install', '--lockfile-only', '--force', '--ignore-scripts'], { cwd: this.bundle, encoding: 'utf8' });
        if (lock.status !== 0)
            throw new Error('Fixture lock failed');
        this.inventory.lockfile.sha256 = PreparedReleaseFixture.sha(readFileSync(join(this.bundle, 'bun.lock')));
        const services: ServiceInstance[] = [];
        this.recipe = { services: {}, volumes: {}, secrets: {} };
        for (let i = 0; i < 5; i++) {
            const serviceId = 'instance-' + i, provider = { pluginId: 'fixture', providerId: 'fixture.container', target: 'deployment', package: { name: '@fixture/plugin', version: '1.0.0', sha256: sha }, entry: 'index.js', classExport: 'ContainerFixture', contractVersion: ProviderV4Schemas.version };
            services.push(ServiceSchemas.service.parse({ serviceId, provider, configuration: {}, definition: ContainerFixture.container.definition, resources: ContainerFixture.container.resources, transitionPolicy: ContainerFixture.container.transitionPolicy, bindings: [{ bindingId: serviceId, contractId: 'fixture.echo', contractVersion: '1.0.0' }], dependencies: [], readiness: { provider: { ...provider, providerId: 'fixture.probe', classExport: 'ProbeFixture' }, configuration: {}, endpoint: { serviceId, portId: 'http' }, deadlineMs: 1000, observationContract: 'fixture.echo' } }));
            this.recipe.services[serviceId] = { image: image.reference };
        }
        services[0]!.definition.ports[0]!.publication = { host: '127.0.0.1', port: 58443 };
        // Publication is selection data; immutable provider metadata bounds its container target.
        this.recipe.services['instance-0']!.ports = [{ target: 8080, published: 58443, host_ip: '127.0.0.1', protocol: 'tcp' }];
        this.configuration.credentialReferences = [];
        this.inventory.recipe.sha256 = this.write('compose.json', this.recipe);
        this.release = ServiceSchemas.release.parse({ ...this.inventory, requiredServices: ['container.service', 'probe.service'], formatVersion: 3, composition: { profile: { id: 'fixture', version: '1.0.0', requiredBindings: services.map(ServiceFixture.binding) }, assetDigest: CanonicalJson.digest([]), worker: { path: 'worker.js', sha256: PreparedReleaseFixture.sha('fixture-worker'), size: 14 }, services } });
        writeFileSync(join(this.bundle, 'worker.js'), 'fixture-worker');
        this.refreshService();
        return this;
    }
    async saveMetadata(value: Record<string, unknown>): Promise<void> { const source = join(this.root, 'plugin/package'); writeFileSync(join(source, 'package.json'), JSON.stringify(value)); await create({ cwd: join(this.root, 'plugin'), file: join(this.bundle, 'archives/plugin.tgz'), gzip: true, portable: true }, ['package']); const hash = PreparedReleaseFixture.sha(readFileSync(join(this.bundle, 'archives/plugin.tgz'))); this.release.packages[0]!.sha256 = hash; this.configuration.plugins[0]!.integrity = hash; for (const service of this.release.composition.services) {
        service.provider.package.sha256 = hash;
        service.readiness.provider.package.sha256 = hash;
    } const lock = spawnSync('bun', ['install', '--lockfile-only', '--force', '--ignore-scripts'], { cwd: this.bundle, encoding: 'utf8' }); if (lock.status !== 0)
        throw new Error('Fixture lock failed'); this.release.lockfile.sha256 = PreparedReleaseFixture.sha(readFileSync(join(this.bundle, 'bun.lock'))); this.refreshService(); }
    private static binding(service: ServiceInstance): string { return service.serviceId; }
    refreshService(): void { this.release.recipe.sha256 = this.write('compose.json', this.recipe); this.configuration.release.manifestDigest = this.write('release.json', this.release); }
}
class ServiceArtifactTests {
    async resolve(): Promise<void> { const fixture = await new ServiceFixture().services(); try {
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
    } }
    async mismatch(): Promise<void> { const fixture = await new ServiceFixture().services(); try {
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
    } }
}
const suite = new ServiceArtifactTests();
test('integration: exact format3 bundle resolves five instances sharing native container and probe exports without imports or state', suite.resolve.bind(suite));
test('unit: owner container projection cannot be overridden by a service instance', suite.mismatch.bind(suite));
class ServiceArtifactProgramTests {
    async program(): Promise<void> { const fixture = await new ServiceFixture().services(); try {
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
    } }
}
const program = new ServiceArtifactProgramTests();
test('smoke: built public deployment artifact verifies a five-service release as a Node program', program.program.bind(program));
class ServiceArtifactBoundaryTests {
    async image(): Promise<void> { const fixture = await new ServiceFixture().services(); try {
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
    } }
    async negative(): Promise<void> { const fixture = await new ServiceFixture().services(); try {
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
    } }
}
const boundaries = new ServiceArtifactBoundaryTests();
test('unit: a container image must be bound by its owning package projection', boundaries.image.bind(boundaries));
test('integration: service configuration export recipe and asset tampering fail safely without state', boundaries.negative.bind(boundaries));

class ServiceExportCalibrationTests {async exports():Promise<void>{const fixture=await new ServiceFixture().services();try{const entry=join(fixture.root,'plugin/package/index.js'),code="import {pathToFileURL} from 'node:url';class Calibration{static async run(){const exports=await import(pathToFileURL(process.argv[1]).href);for(const name of ['ContainerFixture','ProbeFixture'])if(typeof exports[name]!=='function')throw new Error('missing export');process.stdout.write('native-exports-ok\\n');}}await Calibration.run();";expect(existsSync(join(fixture.root,'SCRIPT_CANARY'))).toBe(false);const result=spawnSync('node',['--input-type=module','-e',code,entry],{encoding:'utf8',timeout:10000});expect(result.status).toBe(0);expect(result.stderr).toBe('');expect(result.stdout).toBe('native-exports-ok\n');expect(existsSync(join(fixture.root,'SCRIPT_CANARY'))).toBe(true);}finally{fixture.close();}}}
const calibration=new ServiceExportCalibrationTests();test('smoke: archive fixture exports the same native classes used for metadata and calibrates the import canary',calibration.exports.bind(calibration));

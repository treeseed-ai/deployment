import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create } from 'tar';
import { PackageDefinition, ProviderV4Schemas, PlatformSchemas, ServiceSchemas, CanonicalJson, PlanningBlockedError, type ServiceInstance, type ServiceRelease } from '@treeseed-cordis/sdk';
import { PreparedReleaseFixture,ServiceReleaseFixture as ServiceFixture } from './release-fixture.js';
import { ContainerFixture, ProbeFixture, SharedStaticContainerFixture, SharedStaticProbeFixture } from './service-fixture-plugins.js';

export class ImageCatalogTests {
    protected async sharedFixture(runtime = false): Promise<ServiceFixture> {
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
    protected static program(fixture: ServiceFixture, blocked = false): string {
        const file = join(fixture.root, 'shared-request.json'); writeFileSync(file, JSON.stringify(fixture.configuration));
        const code = "import{readFileSync}from'node:fs';import{PlanningBlockedError}from'@treeseed-cordis/sdk';import{ServiceArtifactResolver}from'@treeseed-cordis/deployment';class Program{static async run(){try{const value=await new ServiceArtifactResolver().resolve(JSON.parse(readFileSync(process.argv[1],'utf8')));if(process.argv[2]==='blocked')throw new Error('Conflicting image ownership accepted');process.stdout.write(value.inventory.composition.services.length+':'+value.artifacts.filter(this.image).length+'\\n');}catch(error){if(process.argv[2]==='blocked'&&error instanceof PlanningBlockedError&&error.blockers.some(this.binding)){process.stdout.write('binding-refused\\n');return;}throw error;}}static image(value){return value.kind==='image';}static binding(value){return value.code==='IMAGE_PACKAGE_BINDING';}}await Program.run();";
        const result = spawnSync('node', ['--input-type=module', '-e', code, file, blocked ? 'blocked' : 'valid'], { encoding: 'utf8', timeout: 15000 }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout;
    }
}

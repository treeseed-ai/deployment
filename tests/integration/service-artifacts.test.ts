import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create } from 'tar';
import { PackageDefinition, ProviderV4Schemas, PlatformSchemas, ServiceSchemas, CanonicalJson, PlanningBlockedError, type ServiceInstance, type ServiceRelease } from '@treeseed-cordis/sdk';
import { PreparedReleaseFixture,ServiceReleaseFixture as ServiceFixture } from '../support/release-fixture.js';
import { ContainerFixture, ProbeFixture, SharedStaticContainerFixture, SharedStaticProbeFixture } from '../support/service-fixture-plugins.js';
import {ImageCatalogTests} from '../support/service-artifacts-test-support.js';
class ServiceArtifactTestsIntegration {

    async resolve(): Promise<void> {
        const fixture = await new ServiceFixture().services();
        try {
            const module = await import('../../src/service-artifacts.js') as unknown as {
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
}
class ServiceArtifactBoundaryTestsIntegration {

    async negative(): Promise<void> {
        const fixture = await new ServiceFixture().services();
        try {
            const { ServiceArtifactResolver } = await import('../../src/service-artifacts.js'), resolver = new ServiceArtifactResolver(), service = fixture.release.composition.services[4]!;
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
class ImageCatalogTestsIntegration extends ImageCatalogTests {

    async selectedOnly(): Promise<void> { const fixture = await new ServiceFixture().services(); try {
        const metadata = JSON.parse(readFileSync(join(fixture.root, 'plugin/package/package.json'), 'utf8')) as { cordisPackage: { images: Array<{ id: string; reference: string }>; runtimeImages?: Array<{ id: string; entry: string }> } }, image = metadata.cordisPackage.images[0]!;
        metadata.cordisPackage.images.push({ ...image, id: 'unselected-image', reference: image.reference.replace('fixture/application', 'fixture/unselected') }); await fixture.saveMetadata(metadata);
        const { ServiceArtifactResolver } = await import('../../src/service-artifacts.js'); expect((await new ServiceArtifactResolver().resolve(fixture.configuration)).inventory.images.length).toBe(1); expect(existsSync(join(fixture.root, 'SCRIPT_CANARY'))).toBe(false);
        metadata.cordisPackage.runtimeImages = [{ id: 'unselected-runtime', entry: 'index.js' }]; await fixture.saveMetadata(metadata); expect((await new ServiceArtifactResolver().resolve(fixture.configuration)).inventory.images.length).toBe(1);
        fixture.release.images.push({ ...fixture.release.images[0]!, id: 'unselected-image', reference: fixture.release.images[0]!.reference.replace('fixture/application', 'fixture/unselected') }); fixture.refreshService(); await expect(new ServiceArtifactResolver().resolve(fixture.configuration)).rejects.toThrow();
    } finally { fixture.close(); } }
}
const suite=new ServiceArtifactTestsIntegration();
const boundaries=new ServiceArtifactBoundaryTestsIntegration();
const imageCatalog=new ImageCatalogTestsIntegration();
test('integration: exact format3 bundle resolves five instances sharing native container and probe exports without imports or state', suite.resolve.bind(suite));
test('integration: service configuration export recipe and asset tampering fail safely without state', boundaries.negative.bind(boundaries));
test('integration: unselected package image declarations need no artifacts while unused inventory remains blocked', imageCatalog.selectedOnly.bind(imageCatalog));

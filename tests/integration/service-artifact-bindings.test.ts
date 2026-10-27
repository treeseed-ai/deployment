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

    async mismatch(): Promise<void> {
        const fixture = await new ServiceFixture().services();
        try {
            fixture.release.composition.services[4]!.definition.command = ['unexpected'];
            fixture.refreshService();
            const module = await import('../../src/service-artifacts.js') as unknown as {
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
class ServiceArtifactBoundaryTestsIntegration {

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
            const { ServiceArtifactResolver } = await import('../../src/service-artifacts.js');
            await expect(new ServiceArtifactResolver().resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);
            expect(existsSync(fixture.installation)).toBe(false);
        }
        finally {
            fixture.close();
        }
    }
}
const suite=new ServiceArtifactTestsIntegration();
const boundaries=new ServiceArtifactBoundaryTestsIntegration();
test("integration: owner container projection cannot be overridden by a service instance", suite.mismatch.bind(suite));
test("integration: a container image must be bound by its owning package projection", boundaries.image.bind(boundaries));

import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { create } from 'tar';
import { PackageDefinition, ProviderV4Schemas, PlatformSchemas, ServiceSchemas, CanonicalJson, PlanningBlockedError, type ServiceInstance, type ServiceRelease } from '@treeseed-cordis/sdk';
import { PreparedReleaseFixture,ServiceReleaseFixture as ServiceFixture } from './release-fixture.js';
import { ContainerFixture, ProbeFixture } from './service-fixture-plugins.js';
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

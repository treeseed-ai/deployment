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
class ServiceArtifactProgramTestsAcceptance {

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
class ServiceExportCalibrationTestsAcceptance {

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
class PublicFixtureTestsAcceptance {

 program():void{const code="import {ServiceReleaseFixture} from '@treeseed-cordis/deployment/testing';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';class Program{static async run(){const cwd=mkdtempSync(join(tmpdir(),'cordis-consumer-cwd-'));process.chdir(cwd);let fixture;try{fixture=await new ServiceReleaseFixture().services();if(fixture.release.composition.services.length!==5)throw new Error('fixture composition');process.stdout.write('public-fixture-ok\\n');}finally{fixture?.close();rmSync(cwd,{recursive:true,force:true});}}}await Program.run();";const result=spawnSync('node',['--input-type=module','-e',code],{encoding:'utf8'});expect(result.status).toBe(0);expect(result.stderr).toBe('');expect(result.stdout).toBe('public-fixture-ok\n');}
}
class ImageCatalogTestsAcceptance extends ImageCatalogTests {

    async shared(): Promise<void> { const fixture = await this.sharedFixture(); try {
        expect(ImageCatalogTests.program(fixture)).toBe('6:1\n'); expect(existsSync(fixture.installation)).toBe(false); expect(existsSync(join(fixture.root, 'SCRIPT_CANARY'))).toBe(false);
        fixture.release.images[0]!.indexSha256 = 'a'.repeat(64); fixture.refreshService(); expect(ImageCatalogTests.program(fixture, true)).toBe('binding-refused\n');
    } finally { fixture.close(); }
        const mixed = await this.sharedFixture(true); try { expect(ImageCatalogTests.program(mixed, true)).toBe('binding-refused\n'); expect(existsSync(mixed.installation)).toBe(false); expect(existsSync(join(mixed.root, 'SCRIPT_CANARY'))).toBe(false); } finally { mixed.close(); }
    }
}
const program=new ServiceArtifactProgramTestsAcceptance();
const calibration=new ServiceExportCalibrationTestsAcceptance();
const publicFixture=new PublicFixtureTestsAcceptance();
const imageCatalog=new ImageCatalogTestsAcceptance();
test("acceptance: built public deployment artifact verifies a five-service release as a Node program", program.program.bind(program));
test("acceptance: public artifact resolver accepts canonical saved credential graphs and still refuses changed secret targets", program.roundtrip.bind(program));
test("acceptance: archive fixture exports the same native classes used for metadata and calibrates the import canary", calibration.exports.bind(calibration));
test("acceptance: public compiled fixture constructs in an unrelated consumer working directory",publicFixture.program.bind(publicFixture));
test("acceptance: public resolver shares exact static images across genuine provider packages and rejects changed pins or runtime ownership", imageCatalog.shared.bind(imageCatalog));

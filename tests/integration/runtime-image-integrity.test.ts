import {test,expect} from 'bun:test';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {create} from 'tar';
import {CanonicalJson,ServiceSchemas,type PluginPackageDescriptor} from '@treeseed-cordis/sdk';
import {ComposeDeploymentHost,ServicePlanStore,ServiceApplicationRuntime} from '@treeseed-cordis/deployment';
import {ServiceArtifactResolver} from '../../src/service-artifacts.js';
import {ServiceObservations} from '../../src/service-observation.js';
import {ServiceReleaseFixture,PreparedReleaseFixture} from '../support/release-fixture.js';
import {RuntimeImageTests} from '../support/runtime-images-test-support.js';
class RuntimeImageTestsIntegration extends RuntimeImageTests {

 async changedEntry():Promise<void>{const fixture=await this.prepare();try{const metadata=JSON.parse(readFileSync(join(fixture.root,'plugin/package/package.json'),'utf8')) as {cordisPackage:PluginPackageDescriptor};metadata.cordisPackage.runtimeImages![0]!.entry='package.json';await fixture.saveMetadata(metadata);await expect(new ServiceArtifactResolver().resolve(fixture.configuration)).rejects.toThrow();}finally{fixture.close();}}

 async missingEntry():Promise<void>{const fixture=await this.prepare();try{const metadata=JSON.parse(readFileSync(join(fixture.root,'plugin/package/package.json'),'utf8')) as {cordisPackage:PluginPackageDescriptor};metadata.cordisPackage.runtimeImages![0]!.entry='absent.js';await fixture.saveMetadata(metadata);await expect(new ServiceArtifactResolver().resolve(fixture.configuration)).rejects.toThrow();}finally{fixture.close();}}
}
const suite=new RuntimeImageTestsIntegration();
test("integration: changed runtime entry or closure cannot reuse an old image acknowledgement",suite.changedEntry.bind(suite));
test("integration: runtime image entry must exist in its owning exact archive",suite.missingEntry.bind(suite));

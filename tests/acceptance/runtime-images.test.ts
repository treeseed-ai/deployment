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
class RuntimeImageTestsAcceptance extends RuntimeImageTests {

 async persisted():Promise<void>{const fixture=await this.prepare();try{const input=join(fixture.root,'runtime-plan.json');writeFileSync(input,JSON.stringify(fixture.configuration));const child=spawnSync('node',['dist/tests/support/service-plan-program.js',input],{encoding:'utf8',timeout:30000});if(child.status!==0)throw new Error(child.stderr);const result=JSON.parse(child.stdout),plan=JSON.parse(readFileSync(join(fixture.installation,'.cordis/plans',result.id+'.json'),'utf8')),bindings=plan.runtimeBindings;expect(bindings).toBeDefined();expect(Object.keys(bindings)).toHaveLength(5);const artifact={kind:'package',name:fixture.release.packages[0]!.name,version:'1.0.0',sha256:fixture.release.packages[0]!.sha256},expected={imageManifestDigest:fixture.release.images[0]!.manifestDigest,packageSetDigest:CanonicalJson.digest([artifact]),entryDigest:PreparedReleaseFixture.sha(readFileSync(join(fixture.root,'plugin/package/index.js')))};for(const service of fixture.release.composition.services){expect(bindings[service.serviceId]).toEqual(expected);const context=new ServiceObservations(ServiceSchemas.plan.parse(plan)).context(service.serviceId);expect(context.identity.runtime).toEqual(expected);expect(Object.isFrozen(context.identity.runtime)).toBe(true);}}finally{fixture.close();}}
}
const suite=new RuntimeImageTestsAcceptance();
test("acceptance: default public planner saves exact per-instance runtime bindings for source-free readback",suite.persisted.bind(suite));

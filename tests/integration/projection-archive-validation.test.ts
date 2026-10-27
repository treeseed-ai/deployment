import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {ServiceProjectionSchemas,ServiceSchemas,type ServiceInstance,type ServiceGraph} from '@treeseed-cordis/sdk';
import {chmodSync,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {create} from 'tar';
import {CanonicalJson} from '@treeseed-cordis/sdk';
import {ServiceArtifactResolver} from '../../src/service-artifacts.js';
import {ServiceReleaseFixture,PreparedReleaseFixture} from '../support/release-fixture.js';
import {ProjectionTests} from '../support/service-projection-test-support.js';
class ProjectionArtifactTestsIntegration  {


 async asyncSchema():Promise<void>{const fixture=await new ServiceReleaseFixture().services();try{const metadata=JSON.parse(readFileSync(join(fixture.root,'plugin/package/package.json'),'utf8')) as {cordisPackage:{providers:Array<{configurationSchema:unknown}>}};metadata.cordisPackage.providers[0]!.configurationSchema={$async:true,type:'object',required:['private_value']};await fixture.saveMetadata(metadata);await expect(new ServiceArtifactResolver().resolve(fixture.configuration)).rejects.toThrow();}finally{fixture.close();}}


 async assetSize():Promise<void>{const fixture=await new ServiceReleaseFixture().services();try{const metadata=JSON.parse(readFileSync(join(fixture.root,'plugin/package/package.json'),'utf8')) as {cordisPackage:{assets:unknown[]}};const bytes=Buffer.from('public fixture asset');writeFileSync(join(fixture.root,'plugin/package/asset.css'),bytes);metadata.cordisPackage.assets=[{path:'asset.css',sha256:PreparedReleaseFixture.sha(bytes),size:bytes.length+1}];fixture.release.composition.assetDigest=CanonicalJson.digest([{package:'@fixture/plugin',version:'1.0.0',path:'asset.css',sha256:PreparedReleaseFixture.sha(bytes)}]);await fixture.saveMetadata(metadata);await expect(new ServiceArtifactResolver().resolve(fixture.configuration)).rejects.toThrow();}finally{fixture.close();}}
}
const artifacts=new ProjectionArtifactTestsIntegration();
test("integration: asynchronous archive configuration is rejected before validator invocation",artifacts.asyncSchema.bind(artifacts));
test("integration: public asset size is bound as well as its digest",artifacts.assetSize.bind(artifacts));

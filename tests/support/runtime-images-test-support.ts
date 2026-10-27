import {test,expect} from 'bun:test';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {create} from 'tar';
import {CanonicalJson,ServiceSchemas,type PluginPackageDescriptor} from '@treeseed-cordis/sdk';
import {ComposeDeploymentHost,ServicePlanStore,ServiceApplicationRuntime} from '@treeseed-cordis/deployment';
import {ServiceArtifactResolver} from '../../src/service-artifacts.js';
import {ServiceObservations} from '../../src/service-observation.js';
import {ServiceReleaseFixture,PreparedReleaseFixture} from './release-fixture.js';
export class RuntimeImageTests {
 protected static delay(done:(value:void)=>void):void{setTimeout(done,50);}
 protected async prepare():Promise<ServiceReleaseFixture>{const fixture=await new ServiceReleaseFixture().services(),metadata=JSON.parse(readFileSync(join(fixture.root,'plugin/package/package.json'),'utf8')) as {cordisPackage:PluginPackageDescriptor};metadata.cordisPackage.images=[];metadata.cordisPackage.runtimeImages=[{id:'application',entry:'index.js'}];await fixture.saveMetadata(metadata);const image=fixture.release.images[0]!,base=join(fixture.bundle,'oci/blobs/sha256'),labels={'ai.treeseed.cordis.package-set':CanonicalJson.digest([{kind:'package',name:fixture.release.packages[0]!.name,version:'1.0.0',sha256:fixture.release.packages[0]!.sha256}]),'ai.treeseed.cordis.admin-asset':fixture.release.composition.assetDigest,'ai.treeseed.cordis.runtime-entry':PreparedReleaseFixture.sha(readFileSync(join(fixture.root,'plugin/package/index.js')))};const config=JSON.stringify({architecture:'amd64',os:'linux',config:{Labels:labels},rootfs:{type:'layers',diff_ids:[]},history:[]}),configDigest=PreparedReleaseFixture.sha(config);writeFileSync(join(base,configDigest),config);const manifest=JSON.stringify({schemaVersion:2,mediaType:'application/vnd.oci.image.manifest.v1+json',config:{mediaType:'application/vnd.oci.image.config.v1+json',digest:'sha256:'+configDigest,size:Buffer.byteLength(config)},layers:[]}),digest=PreparedReleaseFixture.sha(manifest);writeFileSync(join(base,digest),manifest);image.manifestDigest=digest;image.reference='fixture/runtime@sha256:'+digest;image.indexSha256=fixture.write('oci/index.json',{schemaVersion:2,manifests:[{mediaType:'application/vnd.oci.image.manifest.v1+json',digest:'sha256:'+digest,size:Buffer.byteLength(manifest),platform:{os:'linux',architecture:'amd64'}}]});for(const service of Object.values(fixture.recipe.services))service.image=image.reference;fixture.refreshService();return fixture;}
}

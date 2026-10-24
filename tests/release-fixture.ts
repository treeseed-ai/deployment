import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { create } from 'tar';
import { PluginDefinition, type DeploymentConfiguration, type ReleaseInventory, type PluginMetadata, type DeploymentRecipe } from '@treeseed-cordis/sdk';

/** Test-only prepared release producer. Never imported by the deployment entry point. */
export class PreparedReleaseFixture {
  readonly root=mkdtempSync(join(tmpdir(),'cordis prepared '));
  readonly bundle=join(this.root,'release');
  readonly installation=join(this.root,'installation');
  readonly metadata=PluginDefinition.define({id:'fixture',contractVersion:'0.2.0-cordis.1',provide:['fixture'],inject:[]});
  inventory!:ReleaseInventory;
  recipe!:DeploymentRecipe;
  configuration!:DeploymentConfiguration;
  static sha(value:Uint8Array|string):string {return createHash('sha256').update(value).digest('hex');}
  write(path:string,value:unknown):string {const bytes=JSON.stringify(value,null,2)+'\n';writeFileSync(join(this.bundle,path),bytes);return PreparedReleaseFixture.sha(bytes);}
  async prepare(port=58443):Promise<this> {
    mkdirSync(this.bundle);mkdirSync(join(this.bundle,'oci/blobs/sha256'),{recursive:true});mkdirSync(join(this.bundle,'archives'));
    const source=join(this.root,'plugin');mkdirSync(join(source,'package'),{recursive:true});
    const module=`import {writeFileSync} from "node:fs"; export class FixturePlugin { static readonly declaration = ${JSON.stringify(this.metadata)}; static readonly provide=this.declaration.provide; static readonly inject=this.declaration.inject; static mark():void {writeFileSync(${JSON.stringify(join(this.root,'SCRIPT_CANARY'))},"unexpected execution");} } FixturePlugin.mark();`;
    writeFileSync(join(source,'fixture.ts'),module);
    const build=spawnSync('bun',['build',join(source,'fixture.ts'),'--target=node','--outfile',join(source,'package/index.js')],{encoding:'utf8'});
    if(build.status!==0)throw new Error('Fixture class compilation failed');
    writeFileSync(join(source,'package/package.json'),JSON.stringify({name:'@fixture/plugin',version:'1.0.0',type:'module',exports:'./index.js',cordis:this.metadata,scripts:{postinstall:'node ./index.js'}}));
    await create({cwd:source,file:join(this.bundle,'archives/plugin.tgz'),gzip:true,portable:true},['package']);
    const packageDigest=PreparedReleaseFixture.sha(readFileSync(join(this.bundle,'archives/plugin.tgz')));
    this.write('package.json',{name:'cordis-fixture-composition',version:'1.0.0',private:true,dependencies:{'@fixture/plugin':'file:archives/plugin.tgz'}});
    const lock=spawnSync('bun',['install','--lockfile-only','--ignore-scripts'],{cwd:this.bundle,encoding:'utf8'});
    if(lock.status!==0)throw new Error('Fixture standard lock generation failed');
    const config={architecture:'amd64',os:'linux',config:{},rootfs:{type:'layers',diff_ids:[]},history:[]};
    const configBytes=JSON.stringify(config),configDigest=PreparedReleaseFixture.sha(configBytes);writeFileSync(join(this.bundle,'oci/blobs/sha256',configDigest),configBytes);
    const manifest={schemaVersion:2,mediaType:'application/vnd.oci.image.manifest.v1+json',config:{mediaType:'application/vnd.oci.image.config.v1+json',digest:'sha256:'+configDigest,size:Buffer.byteLength(configBytes)},layers:[]};
    const manifestBytes=JSON.stringify(manifest),manifestDigest=PreparedReleaseFixture.sha(manifestBytes);writeFileSync(join(this.bundle,'oci/blobs/sha256',manifestDigest),manifestBytes);
    this.write('oci/oci-layout',{imageLayoutVersion:'1.0.0'});
    const indexSha256=this.write('oci/index.json',{schemaVersion:2,manifests:[{mediaType:'application/vnd.oci.image.manifest.v1+json',digest:'sha256:'+manifestDigest,size:Buffer.byteLength(manifestBytes),platform:{os:'linux',architecture:'amd64'}}]});
    const reference='fixture/application@sha256:'+manifestDigest;
    this.recipe={services:{application:{image:reference,ports:[{target:443,published:port,host_ip:'127.0.0.1',protocol:'tcp'}],volumes:[{type:'volume',source:'data',target:'/data'}],secrets:['password']}},volumes:{data:{}},secrets:{password:{file:'.cordis/credentials/password'}}};
    const recipeDigest=this.write('compose.json',this.recipe);
    this.inventory={formatVersion:1,packageJson:{path:'package.json',sha256:PreparedReleaseFixture.sha(readFileSync(join(this.bundle,'package.json')))},lockfile:{path:'bun.lock',sha256:PreparedReleaseFixture.sha(readFileSync(join(this.bundle,'bun.lock')))},recipe:{path:'compose.json',sha256:recipeDigest},requiredPluginIds:['fixture'],requiredServices:['fixture'],packages:[{name:'@fixture/plugin',version:'1.0.0',path:'archives/plugin.tgz',sha256:packageDigest}],images:[{id:'application',reference,layout:'oci',indexSha256,manifestDigest}]};
    const manifestSha=this.write('release.json',this.inventory);
    this.configuration={installationId:'fixture',engineContext:'default',installationDirectory:this.installation,origin:'https://localhost:'+port,runtimeState:'running',plugins:[{id:'fixture',package:'@fixture/plugin',version:'1.0.0',integrity:packageDigest}],credentialReferences:['secret://password'],release:{directory:this.bundle,manifestDigest:manifestSha}};
    return this;
  }
  imageArchitecture(architecture:string):void {
    const image=this.inventory.images[0]!,blob=join(this.bundle,'oci/blobs/sha256'),manifest=JSON.parse(readFileSync(join(blob,image.manifestDigest),'utf8')) as {config:{digest:string;size:number}},oldConfig=manifest.config.digest.slice(7);
    const config=JSON.parse(readFileSync(join(blob,oldConfig),'utf8')) as Record<string,unknown>;config.architecture=architecture;const bytes=JSON.stringify(config),hash=PreparedReleaseFixture.sha(bytes);writeFileSync(join(blob,hash),bytes);manifest.config={...manifest.config,digest:'sha256:'+hash,size:Buffer.byteLength(bytes)};
    const manifestBytes=JSON.stringify(manifest),digest=PreparedReleaseFixture.sha(manifestBytes);writeFileSync(join(blob,digest),manifestBytes);image.manifestDigest=digest;image.reference='fixture/application@sha256:'+digest;
    image.indexSha256=this.write('oci/index.json',{schemaVersion:2,manifests:[{mediaType:'application/vnd.oci.image.manifest.v1+json',digest:'sha256:'+digest,size:Buffer.byteLength(manifestBytes),platform:{os:'linux',architecture}}]});this.recipe.services.application!.image=image.reference;this.refresh();
  }
  async addPlugin(metadata:PluginMetadata):Promise<void> {
    const source=join(this.root,'additional');mkdirSync(join(source,'package'),{recursive:true});
    writeFileSync(join(source,'additional.ts'),`export class AdditionalPlugin {static readonly declaration=${JSON.stringify(metadata)};static readonly provide=this.declaration.provide;static readonly inject=this.declaration.inject;}`);
    const build=spawnSync('bun',['build',join(source,'additional.ts'),'--target=node','--outfile',join(source,'package/index.js')],{encoding:'utf8'});if(build.status!==0)throw new Error('Additional fixture compilation failed');
    const name='@fixture/additional',path='archives/additional.tgz';writeFileSync(join(source,'package/package.json'),JSON.stringify({name,version:'1.0.0',type:'module',exports:'./index.js',cordis:metadata}));await create({cwd:source,file:join(this.bundle,path),gzip:true,portable:true},['package']);
    const hash=PreparedReleaseFixture.sha(readFileSync(join(this.bundle,path)));this.inventory.packages.push({name,version:'1.0.0',path,sha256:hash});this.configuration.plugins.push({id:metadata.id,package:name,version:'1.0.0',integrity:hash});
    this.inventory.packageJson.sha256=this.write('package.json',{name:'cordis-fixture-composition',version:'1.0.0',private:true,dependencies:{'@fixture/plugin':'file:archives/plugin.tgz',[name]:'file:'+path}});
    const lock=spawnSync('bun',['install','--lockfile-only','--force','--ignore-scripts'],{cwd:this.bundle,encoding:'utf8'});if(lock.status!==0)throw new Error('Additional fixture lock failed');this.inventory.lockfile.sha256=PreparedReleaseFixture.sha(readFileSync(join(this.bundle,'bun.lock')));this.refresh();
  }
  async repack(metadata:PluginMetadata):Promise<void> {
    const source=join(this.root,'plugin'),manifest=join(source,'package/package.json');
    const pkg=JSON.parse(readFileSync(manifest,'utf8')) as Record<string,unknown>;pkg.cordis=metadata;writeFileSync(manifest,JSON.stringify(pkg));
    await create({cwd:source,file:join(this.bundle,'archives/plugin.tgz'),gzip:true,portable:true},['package']);
    const hash=PreparedReleaseFixture.sha(readFileSync(join(this.bundle,'archives/plugin.tgz')));this.inventory.packages[0]!.sha256=hash;this.configuration.plugins[0]!.integrity=hash;
    const result=spawnSync('bun',['install','--lockfile-only','--force','--ignore-scripts'],{cwd:this.bundle,encoding:'utf8'});if(result.status!==0)throw new Error('Fixture lock refresh failed');
    this.inventory.lockfile.sha256=PreparedReleaseFixture.sha(readFileSync(join(this.bundle,'bun.lock')));this.refresh();
  }
  refresh():void {this.inventory.recipe.sha256=this.write('compose.json',this.recipe);this.configuration.release.manifestDigest=this.write('release.json',this.inventory);}
  close():void {rmSync(this.root,{recursive:true,force:true});}
}

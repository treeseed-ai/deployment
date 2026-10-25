import {fileURLToPath} from 'node:url';
import {ContainerFixture,ProbeFixture,CredentialContainerFixture,CredentialConsumerFixture,RuntimeContainerFixture,QualificationProbeFixture} from './service-fixture-plugins.js';
import {readdirSync,chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { create } from 'tar';
import {ServiceProjection} from '../src/service-projection.js';
import { PackageDefinition,ProviderV4Schemas,ServiceSchemas,CanonicalJson,type ServiceInstance,type ServiceRelease,PluginDefinition, type DeploymentConfiguration, type ReleaseInventory, type PluginMetadata, type DeploymentRecipe } from '@treeseed-cordis/sdk';

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
    const config={architecture:'amd64',os:'linux',config:{Labels:{'ai.treeseed.cordis.test-fixture':PreparedReleaseFixture.sha(this.root)}},rootfs:{type:'layers',diff_ids:[]},history:[]};
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
  close():void {PreparedReleaseFixture.writable(this.root);rmSync(this.root,{recursive:true,force:true});}
  private static writable(path:string):void{chmodSync(path,0o700);for(const entry of readdirSync(path,{withFileTypes:true})){const file=join(path,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory())this.writable(file);else chmodSync(file,0o600);}}
}

export class ServiceReleaseFixture extends PreparedReleaseFixture {
    release!: ServiceRelease;
    async services(): Promise<this> {
        await this.prepare();
        const source = join(this.root, 'plugin/package'), image = this.inventory.images[0]!, images = [{ id: image.id, reference: image.reference, manifestDigest: image.manifestDigest, indexSha256: image.indexSha256, source: { kind: 'oci-archive' as const, url: 'https://fixture.invalid/image.tar', sha256: 'a'.repeat(64), size: 1 } }];
        const entry = join(this.root, 'provider-entry.ts');
        writeFileSync(entry, `import {writeFileSync} from 'node:fs';export {ContainerFixture,ProbeFixture,CredentialContainerFixture,CredentialConsumerFixture,RuntimeContainerFixture,QualificationProbeFixture} from ${JSON.stringify(fileURLToPath(new URL(import.meta.url.endsWith('.ts')?'./service-fixture-plugins.ts':'./service-fixture-plugins.js',import.meta.url)))};class Canary{static run():void{writeFileSync(${JSON.stringify(join(this.root, 'SCRIPT_CANARY'))},'imported');}}Canary.run();`);
        const build = spawnSync('bun', ['build', entry, '--target=node', '--outfile', join(source, 'index.js')], { encoding: 'utf8' });
        if (build.status !== 0)
            throw new Error('Provider fixture compilation failed');
        const metadata = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as Record<string, unknown>;
        metadata.cordisPackage = PackageDefinition.define('@fixture/plugin', '1.0.0', 'fixture', [PackageDefinition.export(ContainerFixture, 'index.js', 'ContainerFixture'), PackageDefinition.export(ProbeFixture, 'index.js', 'ProbeFixture')], [], images);
        writeFileSync(join(source, 'package.json'), JSON.stringify(metadata));
        await create({ cwd: join(this.root, 'plugin'), file: join(this.bundle, 'archives/plugin.tgz'), gzip: true, portable: true }, ['package']);
        const sha = PreparedReleaseFixture.sha(readFileSync(join(this.bundle, 'archives/plugin.tgz')));
        this.inventory.packages[0]!.sha256 = sha;
        this.configuration.plugins[0]!.integrity = sha;
        const lock = spawnSync('bun', ['install', '--lockfile-only', '--force', '--ignore-scripts'], { cwd: this.bundle, encoding: 'utf8' });
        if (lock.status !== 0)
            throw new Error('Fixture lock failed: '+lock.stderr.slice(0,2000));
        this.inventory.lockfile.sha256 = PreparedReleaseFixture.sha(readFileSync(join(this.bundle, 'bun.lock')));
        const services: ServiceInstance[] = [];
        this.recipe = { services: {}, volumes: {}, secrets: {} };
        for (let i = 0; i < 5; i++) {
            const serviceId = 'instance-' + i, provider = { pluginId: 'fixture', providerId: 'fixture.container', target: 'deployment', package: { name: '@fixture/plugin', version: '1.0.0', sha256: sha }, entry: 'index.js', classExport: 'ContainerFixture', contractVersion: ProviderV4Schemas.version };
            services.push(ServiceSchemas.service.parse({ serviceId, provider, configuration: {}, definition: ContainerFixture.container.definition, resources: ContainerFixture.container.resources, transitionPolicy: ContainerFixture.container.transitionPolicy, bindings: [{ port:'http',bindingId: serviceId, contractId: 'fixture.echo', contractVersion: '1.0.0' }], dependencies: [], readiness: { provider: { ...provider, providerId: 'fixture.probe', classExport: 'ProbeFixture' }, configuration: {}, endpoint: { serviceId, portId: 'http' }, deadlineMs: 1000, observationContract: 'fixture.echo' } }));
            this.recipe.services[serviceId] = { image: image.reference };
        }
        services[0]!.definition.ports[0]!.publication = { host: '127.0.0.1', port: 58443 };
        // Publication is selection data; immutable provider metadata bounds its container target.
        this.recipe.services['instance-0']!.ports = [{ target: 8080, published: 58443, host_ip: '127.0.0.1', protocol: 'tcp' }];
        this.configuration.credentialReferences = [];
        this.inventory.recipe.sha256 = this.write('compose.json', this.recipe);
        this.release = ServiceSchemas.release.parse({ ...this.inventory, requiredServices: ['container.service', 'probe.service'], formatVersion: 3, composition: { profile: { id: 'fixture', version: '1.0.0', requiredBindings: services.map(ServiceReleaseFixture.binding) }, assetDigest: CanonicalJson.digest([]), worker: { path: 'worker.js', sha256: PreparedReleaseFixture.sha('fixture-worker'), size: 14 }, services } });
        writeFileSync(join(this.bundle, 'worker.js'), 'fixture-worker');
        this.refreshService();
        return this;
    }
    async withCredentials():Promise<this>{await this.services();const graph=this.release.composition;for(let i=0;i<3;i++){const service=graph.services[i]!,plugin=i===2?CredentialConsumerFixture:CredentialContainerFixture;service.provider={...service.provider,providerId:plugin.declaration.id,classExport:plugin.name};service.definition=ServiceSchemas.definition.parse(plugin.container.definition);service.resources=ServiceSchemas.service.shape.resources.parse({...plugin.container.resources,grants:i===2?[{serviceId:'instance-0',slot:'password'}]:[]});if(i===2){service.dependencies=[{port:'primary',bindingId:'instance-0',contractId:'fixture.echo',contractVersion:'1.0.0'}];service.readiness.credentialReferences=['secret://instance-0/password'];}}
      for(let i=0;i<3;i++){const service=graph.services[i]!,plugin=i===2?CredentialConsumerFixture:CredentialContainerFixture,projected=ServiceProjection.resolve(service,plugin.container,graph,this.configuration);service.definition=projected.definition;service.resources=projected.resources;if(i===0)service.definition.ports[0]!.publication={host:'127.0.0.1',port:Number(new URL(this.configuration.origin).port)};}
      this.configuration.credentialReferences=[];for(const service of graph.services){const recipe=this.recipe.services[service.serviceId]!;if(service.dependencies.length)recipe.depends_on=['instance-0'];if(service.definition.secrets.length)recipe.secrets=[];for(const slot of Object.keys(service.resources.slots)){const key='r-'+CanonicalJson.digest({serviceId:service.serviceId,slot}).slice(0,48);this.recipe.secrets[key]={file:'.cordis/credentials/'+service.serviceId+'/'+slot};this.configuration.credentialReferences.push('secret://'+service.serviceId+'/'+slot);}for(const secret of service.definition.secrets)recipe.secrets!.push('r-'+CanonicalJson.digest({serviceId:service.serviceId,slot:secret.slot}).slice(0,48));}
      const metadata=JSON.parse(readFileSync(join(this.root,'plugin/package/package.json'),'utf8')) as Record<string,unknown>,old=metadata.cordisPackage as {images:NonNullable<Parameters<typeof PackageDefinition.define>[5]>};metadata.cordisPackage=PackageDefinition.define('@fixture/plugin','1.0.0','fixture',[PackageDefinition.export(ContainerFixture,'index.js','ContainerFixture'),PackageDefinition.export(CredentialContainerFixture,'index.js','CredentialContainerFixture'),PackageDefinition.export(CredentialConsumerFixture,'index.js','CredentialConsumerFixture'),PackageDefinition.export(ProbeFixture,'index.js','ProbeFixture')],[],old.images);await this.saveMetadata(metadata);return this;}
    async saveMetadata(value: Record<string, unknown>): Promise<void> {
        const source = join(this.root, 'plugin/package');
        writeFileSync(join(source, 'package.json'), JSON.stringify(value));
        await create({ cwd: join(this.root, 'plugin'), file: join(this.bundle, 'archives/plugin.tgz'), gzip: true, portable: true }, ['package']);
        const hash = PreparedReleaseFixture.sha(readFileSync(join(this.bundle, 'archives/plugin.tgz')));
        this.release.packages[0]!.sha256 = hash;
        this.configuration.plugins[0]!.integrity = hash;
        for (const service of this.release.composition.services) {
            service.provider.package.sha256 = hash;
            service.readiness.provider.package.sha256 = hash;
        }
        const lock = spawnSync('bun', ['install', '--lockfile-only', '--force', '--ignore-scripts'], { cwd: this.bundle, encoding: 'utf8' });
        if (lock.status !== 0)
            throw new Error('Fixture lock failed: '+lock.stderr.slice(0,2000));
        this.release.lockfile.sha256 = PreparedReleaseFixture.sha(readFileSync(join(this.bundle, 'bun.lock')));
        this.refreshService();
    }
    private static binding(service: ServiceInstance): string { return service.serviceId; }
    refreshService(): void { this.release.recipe.sha256 = this.write('compose.json', this.recipe); this.configuration.release.manifestDigest = this.write('release.json', this.release); }
}

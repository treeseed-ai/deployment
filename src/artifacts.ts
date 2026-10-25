import { createHash } from 'node:crypto';
import { Parser, type ReadEntry } from 'tar';
import { satisfies, valid } from 'semver';
import { PlatformSchemas, CanonicalJson, PlanningBlockedError, InstalledSchemas,ProviderSchemas,type ProviderDeclaration,type InstalledRelease,type ContainerDefinition,type DeploymentConfiguration, type DeploymentPlan, type ReleaseInventory, type DeploymentRecipe, type PluginMetadata } from '@treeseed-cordis/sdk';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';

interface ArchiveReadLimits { bytes: number; entries: number; files: number; file: number; }
export class ArchiveMetadata {
  readonly parser:Parser;
  readonly paths=new Set<string>();
  readonly hashes=new Map<string,string>();
  readonly sizes=new Map<string,number>();
  readonly modes=new Map<string,number>();
  metadata:unknown=null;
  failure=false;
  bytes=0;
  maximumFile=0;
  chunks:Buffer[]=[];
  resolveResult:((value:Record<string,unknown>)=>void)|null=null;
  rejectResult:((error:Error)=>void)|null=null;
  constructor(readonly archive:Buffer,private readonly helper=false,private readonly limits:ArchiveReadLimits={bytes:1024**3,entries:100000,files:100000,file:1024**3}) {this.parser=new Parser({strict:true,maxMetaEntrySize:1024*1024,maxDecompressionRatio:1000,onReadEntry:this.entry.bind(this)});}
  read():Promise<Record<string,unknown>> {return new Promise(this.start.bind(this));}
  private start(resolve:(value:Record<string,unknown>)=>void,reject:(error:Error)=>void):void {this.resolveResult=resolve;this.rejectResult=reject;this.parser.on('error',this.error.bind(this));this.parser.once('end',this.end.bind(this));this.parser.end(this.archive);}
  private entry(entry:ReadEntry):void {
    const path=entry.path.replace(/\/$/,'');
    if(!this.helper&&!path.startsWith('package/')&&path!=='package')this.failure=true;
    if(!path.split('/').every(SafeDirectory.component)||this.paths.has(path)||!['File','Directory','OldFile'].includes(entry.type))this.failure=true;
    this.paths.add(path);this.bytes+=entry.size;this.maximumFile=Math.max(this.maximumFile,entry.size);if(this.failure||!this.bounded(entry)){this.failure=true;entry.resume();this.parser.abort(new Error('ARCHIVE_LIMIT'));return;}if(entry.type==='File'||entry.type==='OldFile'){this.sizes.set(path,entry.size);this.modes.set(path,(entry.mode??0)&0o7777);const hash=new ArchiveFileHash(path,this.hashes);entry.on('data',hash.data.bind(hash));entry.once('end',hash.end.bind(hash));}
    if(this.paths.size>100000||this.bytes>1024**3)this.failure=true;
    if(path==='package/package.json'&&entry.type==='File'&&entry.size<=1024*1024){entry.on('data',this.data.bind(this));entry.once('end',this.metadataEnd.bind(this));}
    else entry.resume();
  }
  private bounded(entry:ReadEntry):boolean {return this.paths.size<=this.limits.entries&&this.bytes<=this.limits.bytes&&entry.size<=this.limits.file&&this.sizes.size+(['File','OldFile'].includes(entry.type)?1:0)<=this.limits.files;}
  private data(value:Buffer):void {this.chunks.push(value);}
  private metadataEnd():void {try{this.metadata=StrictJson.parse(Buffer.concat(this.chunks));}catch{this.failure=true;}}
  private error():void {this.rejectResult!(new PlanningBlockedError([{code:'INVALID_ARCHIVE',message:'Package archive inspection failed.'}]));}
  private end():void {try{Check.require(!this.failure&&(this.metadata||this.helper),'INVALID_ARCHIVE');this.resolveResult!(StrictJson.object(this.metadata??{}));}catch(error){this.rejectResult!(error as Error);}}
}
class ArchiveFileHash {
 private readonly hash=createHash('sha256');constructor(private readonly path:string,private readonly hashes:Map<string,string>){}
 data(bytes:Buffer):void{this.hash.update(bytes);}end():void{this.hashes.set(this.path,this.hash.digest('hex'));}
}
class DependencyGraph {
  readonly visiting=new Set<string>();
  readonly visited=new Set<string>();
  constructor(readonly edges:Map<string,string[]>) {}
  validate():void {for(const name of this.edges.keys())this.visit(name);}
  private visit(name:string):void {Check.require(this.edges.has(name),'MISSING_SERVICE');Check.require(!this.visiting.has(name),'DEPENDENCY_CYCLE');if(this.visited.has(name))return;this.visiting.add(name);for(const dependency of this.edges.get(name)!)this.visit(dependency);this.visiting.delete(name);this.visited.add(name);}
}
export interface PackageData {sizes:Map<string,number>;hashes:Map<string,string>;files:Set<string>;entry:ReleaseInventory['packages'][number];metadata:Record<string,unknown>;bytes:Buffer;}
export interface ArtifactResolution {inventory:ReleaseInventory|InstalledRelease;recipe:DeploymentRecipe;pluginBindings:Array<PluginMetadata|ProviderDeclaration>;artifacts:DeploymentPlan['artifacts'];releaseDigest:string;lockDigest:string;recipeDigest:string;}
export class ArtifactResolver {
  resolve(configuration:DeploymentConfiguration):Promise<ArtifactResolution & {inventory:ReleaseInventory;pluginBindings:PluginMetadata[]}>;
  resolve(configuration:DeploymentConfiguration,installed:true,bundled:ProviderDeclaration[]):Promise<ArtifactResolution & {inventory:InstalledRelease;pluginBindings:ProviderDeclaration[]}>;
  async resolve(configuration:DeploymentConfiguration,installed=false,bundled:ProviderDeclaration[]=[]):Promise<ArtifactResolution> {
    const directory=SafeDirectory.open(configuration.release.directory);
    try {
      const releaseBytes=directory.file('release.json',configuration.release.manifestDigest),inventory=installed?this.schema(InstalledSchemas.release.safeParse(StrictJson.parse(releaseBytes))):this.schema(PlatformSchemas.release.safeParse(StrictJson.parse(releaseBytes)));
      const root=StrictJson.object(StrictJson.parse(directory.file(inventory.packageJson.path,inventory.packageJson.sha256)));
      const lock=StrictJson.object(StrictJson.parse(directory.file(inventory.lockfile.path,inventory.lockfile.sha256),true));
      const recipe=this.schema(PlatformSchemas.recipe.safeParse(StrictJson.parse(directory.file(inventory.recipe.path,inventory.recipe.sha256))));
      Check.require(inventory.packages.length<=256&&inventory.images.length<=64,'INVENTORY_LIMIT');
      const packages=new Map<string,PackageData>(),paths=new Set<string>();let runtimeBytes=0,runtimeFiles=0;
      for(const entry of inventory.packages){Check.require(!packages.has(entry.name)&&!paths.has(entry.path)&&valid(entry.version),'DUPLICATE_PACKAGE');paths.add(entry.path);const bytes=directory.file(entry.path,entry.sha256),reader=new ArchiveMetadata(bytes),metadata=await reader.read();if(installed){runtimeBytes+=reader.bytes;runtimeFiles+=reader.hashes.size;Check.require(runtimeBytes<=64*1024*1024&&runtimeFiles<=4096&&reader.maximumFile<=8*1024*1024,'PROVIDER_CLOSURE');for(const path of reader.paths)Check.require(PlatformSchemas.relative.safeParse(path).success,'PROVIDER_PATH');}Check.require(metadata.name===entry.name&&metadata.version===entry.version,'PACKAGE_IDENTITY');packages.set(entry.name,{entry,bytes,metadata,files:reader.paths,hashes:reader.hashes,sizes:reader.sizes});}
      this.lock(root,lock,packages,installed);const pluginBindings=inventory.formatVersion===2?this.installedPlugins(configuration,inventory,packages,bundled,recipe):this.plugins(configuration,inventory,packages);this.recipe(configuration,inventory,recipe);if(inventory.formatVersion===2)ContainerTemplates.validate(inventory.composition,configuration,recipe);
      const artifacts:DeploymentPlan['artifacts']=[];
      for(const name of [...packages.keys()].sort()){const entry=packages.get(name)!.entry;artifacts.push({kind:'package',name:entry.name,version:entry.version,sha256:entry.sha256});}
      const images=[...inventory.images];images.sort(ArtifactResolver.imageOrder);
      for(const image of images)artifacts.push(this.image(directory,image,installed));if(inventory.formatVersion===2)this.installedImages(directory,inventory,artifacts);
      directory.verify();
      return {inventory,recipe,pluginBindings,artifacts,releaseDigest:configuration.release.manifestDigest,lockDigest:inventory.lockfile.sha256,recipeDigest:inventory.recipe.sha256};
    }catch(error){if(error instanceof PlanningBlockedError)throw error;return Check.block('INVALID_RELEASE');}finally{directory.close();}
  }
  static imageOrder(a:ReleaseInventory['images'][number],b:ReleaseInventory['images'][number]):number {return a.reference.localeCompare(b.reference);}
  protected schema<T>(result:{success:true;data:T}|{success:false}):T {Check.require(result.success,'INVALID_RELEASE_SCHEMA');return result.data;}
  private fields(value:unknown):Record<string,unknown> {return value===undefined?{}:StrictJson.object(value);}
  private unsupported(metadata:Record<string,unknown>,installed=false):void {
    for(const key of ['optionalDependencies','overrides','resolutions','workspaces','bundledDependencies','bundleDependencies','peerDependenciesMeta'])if(metadata[key]!==undefined&&!(installed&&key==='peerDependenciesMeta'))Check.require(Object.keys(this.fields(metadata[key])).length===0,'UNSUPPORTED_DEPENDENCIES');
  }
  protected lock(root:Record<string,unknown>,lock:Record<string,unknown>,packages:Map<string,PackageData>,installed=false):void {
    this.unsupported(root,installed);Check.require(lock.lockfileVersion===2&&lock.configVersion===1,'UNSUPPORTED_LOCK');
    const workspaces=StrictJson.object(lock.workspaces);Check.require(Object.keys(workspaces).length===1&&workspaces[''],'UNSUPPORTED_WORKSPACE');
    const workspace=StrictJson.object(workspaces['']),dependencies=this.fields(root.dependencies);
    Check.require(CanonicalJson.stringify(dependencies)===CanonicalJson.stringify(this.fields(workspace.dependencies)),'LOCK_ROOT_MISMATCH');
    const records=StrictJson.object(lock.packages);Check.require(Object.keys(records).length===packages.size,'LOCK_CLOSURE');
    const queue=Object.keys(dependencies),visited=new Set<string>();
    for(const name of queue){const data=packages.get(name);Check.require(data,'MISSING_PACKAGE');const range=dependencies[name];Check.require(typeof range==='string'&&(range==='file:'+data.entry.path||satisfies(data.entry.version,range)),'DEPENDENCY_VERSION');}
    while(queue.length){const name=queue.shift()!;if(visited.has(name))continue;visited.add(name);const data=packages.get(name);Check.require(data,'MISSING_PACKAGE');this.unsupported(data.metadata,installed);
      const record=records[name];Check.require(Array.isArray(record)&&(record.length===3||record.length===4),'UNSUPPORTED_LOCK_ENTRY');
      const locator=record[0],local=record.length===3;
      Check.require(locator===(local?name+'@'+data.entry.path:name+'@'+data.entry.version),'LOCK_PACKAGE_IDENTITY');
      if(!local)Check.require(typeof record[1]==='string'&&(record[1]===''||/^https:\/\//.test(record[1])),'UNSUPPORTED_LOCK_ENTRY');
      const meta=StrictJson.object(record[local?1:2]);if(installed)this.optionalPeers(data.metadata,meta);const integrity=record[record.length-1];Check.require(typeof integrity==='string'&&/^sha(256|512)-[a-zA-Z0-9+/]+=*$/.test(integrity),'LOCK_INTEGRITY');
      const algorithm=integrity.startsWith('sha512-')?'sha512':'sha256';Check.require(createHash(algorithm).update(data.bytes).digest('base64')===integrity.slice(algorithm.length+1),'LOCK_INTEGRITY');
      for(const field of ['dependencies','peerDependencies']){
        const declared=this.fields(data.metadata[field]),expected=installed&&field==='peerDependencies'?this.lockPeers(data.metadata):declared;Check.require(CanonicalJson.stringify(expected)===CanonicalJson.stringify(this.fields(meta[field])),'LOCK_METADATA_MISMATCH');
        for(const [dependency,range] of Object.entries(declared)){const target=packages.get(dependency);if(installed&&field==='peerDependencies'&&!target&&this.optionalPeer(data.metadata,meta,dependency))continue;Check.require(typeof range==='string'&&target&&satisfies(target.entry.version,range),'DEPENDENCY_VERSION');queue.push(dependency);}
      }
      this.unsupported(meta,installed);
    }
    Check.require(visited.size===packages.size,'UNUSED_PACKAGE');
  }
  private lockPeers(metadata:Record<string,unknown>):Record<string,unknown>{const dependencies=this.fields(metadata.dependencies),peers=this.fields(metadata.peerDependencies),result:Record<string,unknown>={};for(const [name,range] of Object.entries(peers))if(!Object.hasOwn(dependencies,name)||dependencies[name]!==range)result[name]=range;return result;}
  private optionalPeers(metadata:Record<string,unknown>,lock:Record<string,unknown>):void {const entries=this.fields(metadata.peerDependenciesMeta),expected:string[]=[],peers=this.fields(metadata.peerDependencies);for(const [name,value] of Object.entries(entries)){const item=StrictJson.object(value);Check.require(Object.keys(item).join(',')==='optional'&&item.optional===true&&Object.hasOwn(peers,name),'UNSUPPORTED_DEPENDENCIES');if(Object.hasOwn(this.lockPeers(metadata),name))expected.push(name);}const actual=lock.optionalPeers??[];Check.require(Array.isArray(actual)&&actual.every(ArtifactResolver.peerName)&&CanonicalJson.stringify([...actual].sort())===CanonicalJson.stringify(expected.sort()),'LOCK_METADATA_MISMATCH');}
  private static peerName(value:unknown):boolean{return typeof value==='string';}
  private optionalPeer(metadata:Record<string,unknown>,lock:Record<string,unknown>,name:string):boolean {
    const peers=this.fields(metadata.peerDependenciesMeta),entry=peers[name];if(entry===undefined)return false;const value=StrictJson.object(entry);Check.require(Object.keys(value).join(',')==='optional'&&value.optional===true&&Array.isArray(lock.optionalPeers)&&lock.optionalPeers.includes(name),'LOCK_METADATA_MISMATCH');return true;
  }
  private plugins(configuration:DeploymentConfiguration,inventory:ReleaseInventory,packages:Map<string,PackageData>):PluginMetadata[] {
    const selected=new Map<string,PluginMetadata>(),providers=new Map<string,string>(),packageNames=new Set<string>();
    for(const plugin of configuration.plugins){Check.require(!selected.has(plugin.id)&&!packageNames.has(plugin.package),'DUPLICATE_PLUGIN');packageNames.add(plugin.package);const data=packages.get(plugin.package);Check.require(data&&data.entry.version===plugin.version&&data.entry.sha256===plugin.integrity,'PLUGIN_ARTIFACT_MISMATCH');const metadata=this.schema(PlatformSchemas.pluginDefinition.safeParse(data.metadata.cordis));Check.require(metadata.id===plugin.id,'PLUGIN_IDENTITY');selected.set(plugin.id,metadata);for(const name of metadata.provide){Check.require(!providers.has(name),'DUPLICATE_SERVICE');providers.set(name,plugin.id);}}
    for(const id of inventory.requiredPluginIds)Check.require(selected.has(id),'MISSING_PLUGIN');
    for(const name of inventory.requiredServices)Check.require(providers.has(name),'MISSING_SERVICE');
    const edges=new Map<string,string[]>();for(const [id,metadata] of selected){const dependencies:string[]=[];for(const name of metadata.inject){const provider=providers.get(name);Check.require(provider,'MISSING_SERVICE');dependencies.push(provider);}edges.set(id,dependencies);}new DependencyGraph(edges).validate();return [...selected.values()];
  }
  private installedPlugins(configuration:DeploymentConfiguration,inventory:InstalledRelease,packages:Map<string,PackageData>,bundled:ProviderDeclaration[],recipe:DeploymentRecipe):ProviderDeclaration[] {
    const declarations:ProviderDeclaration[]=[...bundled],selected=new Set<string>(),packageNames=new Set<string>();
    for(const plugin of configuration.plugins){const data=packages.get(plugin.package);Check.require(data&&data.entry.version===plugin.version&&data.entry.sha256===plugin.integrity,'PLUGIN_ARTIFACT_MISMATCH');const root=this.schema(ProviderSchemas.declaration.safeParse(data.metadata.cordis));Check.require(root.id===plugin.id&&!selected.has(plugin.id)&&!packageNames.has(plugin.package),'DUPLICATE_PLUGIN');selected.add(plugin.id);packageNames.add(plugin.package);declarations.push(root);if(data.metadata.cordisProviders!==undefined){Check.require(Array.isArray(data.metadata.cordisProviders),'INVALID_PROVIDER_DECLARATION');for(const value of data.metadata.cordisProviders)declarations.push(this.schema(ProviderSchemas.declaration.safeParse(value)));}}
    const providers=new Map<string,ProviderDeclaration>();
    for(const value of declarations){const key=value.target+':'+value.capability;Check.require(!providers.has(key),'DUPLICATE_SERVICE');Check.require(value.provide.length===1&&value.provide[0]===value.capability,'DECLARATION_DRIFT');providers.set(key,value);}
    for(const id of inventory.requiredPluginIds)Check.require(selected.has(id),'MISSING_PLUGIN');
    for(const capability of inventory.requiredServices){let found=false;for(const value of declarations)if(value.capability===capability)found=true;Check.require(found,'MISSING_SERVICE');}
    const edges=new Map<string,string[]>();for(const [key,value] of providers){const inject:string[]=[];for(const dependency of value.inject){if(dependency==='cordis.composition')continue;const required=value.target+':'+dependency;Check.require(providers.has(required),'MISSING_SERVICE');inject.push(required);}edges.set(key,inject);}new DependencyGraph(edges).validate();
    const roles=new Set<string>();for(const service of inventory.composition.services){Check.require(!roles.has(service.role),'DUPLICATE_SERVICE');roles.add(service.role);const actual=providers.get('deployment:'+service.provider.capability);Check.require(actual&&CanonicalJson.stringify(actual)===CanonicalJson.stringify(service.provider),'SERVICE_PROVIDER_MISMATCH');if(service.package){const data=packages.get(service.package);Check.require(data&&packageNames.has(service.package)&&service.entry&&data.files.has('package/'+service.entry)&&CanonicalJson.stringify(data.metadata.cordis)===CanonicalJson.stringify(service.provider),'SERVICE_PACKAGE_MISMATCH');Check.require(CanonicalJson.stringify(this.schema(InstalledSchemas.definition.safeParse(data.metadata.cordisService)))===CanonicalJson.stringify(service.definition),'SERVICE_RECIPE_MISMATCH');}else Check.require(bundled.some(ArtifactResolver.sameDeclaration.bind(null,service.provider)),'SERVICE_PACKAGE_MISMATCH');const image=inventory.images.find(ArtifactResolver.imageId.bind(null,service.imageId));Check.require(image&&recipe.services[service.role]?.image===image.reference&&inventory.composition.services.filter(ArtifactResolver.sameImage.bind(null,service.imageId)).length===1,'SERVICE_IMAGE_MISMATCH');}
    const admin=packages.get('@treeseed-cordis/admin');Check.require(admin,'MISSING_ADMIN_ASSET');const asset=this.schema(PlatformSchemas.file.safeParse(admin.metadata.cordisAsset));Check.require(asset.sha256===inventory.composition.assetDigest&&admin.hashes.get('package/'+asset.path)===asset.sha256,'ADMIN_ASSET_MISMATCH');
    const directory=SafeDirectory.open(configuration.release.directory);try{const worker=inventory.composition.worker;Check.require(directory.file(worker.path,worker.sha256,512*1024*1024).length===worker.size,'WORKER_INTEGRITY');}finally{directory.close();}return declarations;
  }
  private static sameDeclaration(expected:ProviderDeclaration,value:ProviderDeclaration):boolean{return CanonicalJson.stringify(expected)===CanonicalJson.stringify(value);}
  private static imageId(id:string,value:ReleaseInventory['images'][number]):boolean{return value.id===id;}
  private static sameImage(id:string,value:InstalledRelease['composition']['services'][number]):boolean{return value.imageId===id;}
  private installedImages(directory:SafeDirectory,inventory:InstalledRelease,artifacts:DeploymentPlan['artifacts']):void {
    let imageId='';for(const service of inventory.composition.services)if(service.role==='api')imageId=service.imageId;let image:InstalledRelease['images'][number]|undefined;for(const value of inventory.images)if(value.id===imageId)image=value;Check.require(image,'MISSING_IMAGE');let configDigest='';const packages:DeploymentPlan['artifacts']=[];for(const artifact of artifacts){if(artifact.kind==='package')packages.push(artifact);else if(artifact.manifestDigest===image.manifestDigest)configDigest=artifact.configDigest;}Check.require(configDigest,'MISSING_IMAGE');const layout=directory.directory(image.layout);try{const config=StrictJson.object(StrictJson.parse(layout.file('blobs/sha256/'+configDigest,configDigest,4*1024*1024))),labels=StrictJson.object(StrictJson.object(config.config).Labels);Check.require(labels['ai.treeseed.cordis.package-set']===CanonicalJson.digest(packages)&&labels['ai.treeseed.cordis.admin-asset']===inventory.composition.assetDigest,'IMAGE_PACKAGE_BINDING');}finally{layout.close();}
  }
  private recipe(configuration:DeploymentConfiguration,inventory:ReleaseInventory|InstalledRelease,recipe:DeploymentRecipe):void {
    const references=new Set<string>(),ids=new Set<string>();for(const image of inventory.images){Check.require(!references.has(image.reference)&&!ids.has(image.id),'DUPLICATE_IMAGE');Check.require(!image.reference.split('@')[0]!.split('/').pop()!.includes(':'),'MUTABLE_IMAGE_REFERENCE');Check.require(image.reference.endsWith('@sha256:'+image.manifestDigest),'IMAGE_REFERENCE_MISMATCH');references.add(image.reference);ids.add(image.id);}
    const usedImages=new Set<string>(),usedVolumes=new Set<string>(),usedSecrets=new Set<string>(),ports:NonNullable<DeploymentRecipe['services'][string]['ports']>=[],edges=new Map<string,string[]>();
    for(const [name,service] of Object.entries(recipe.services)){
      Check.require(references.has(service.image),'MISSING_IMAGE');usedImages.add(service.image);edges.set(name,service.depends_on??[]);
      for(const port of service.ports??[])ports.push(port);
      for(const mount of service.volumes??[]){Check.require(!mount.target.includes('$'),'RECIPE_INTERPOLATION');Check.require(Object.hasOwn(recipe.volumes,mount.source),'MISSING_VOLUME');usedVolumes.add(mount.source);}
      for(const secret of service.secrets??[]){Check.require(Object.hasOwn(recipe.secrets,secret),'MISSING_SECRET');usedSecrets.add(secret);}
    }
    new DependencyGraph(edges).validate();Check.require(usedImages.size===references.size&&usedVolumes.size===Object.keys(recipe.volumes).length&&(inventory.formatVersion===2||usedSecrets.size===Object.keys(recipe.secrets).length),'UNUSED_RECIPE_INPUT');
    Check.require(edges.size>0,'EMPTY_RECIPE');
    const origin=new URL(configuration.origin),port=Number(origin.port||(origin.protocol==='https:'?443:80)),host=origin.hostname==='[::1]'?'::1':'127.0.0.1';
    Check.require(ports.length===1&&ports[0]!.published===port&&ports[0]!.host_ip===host,'ORIGIN_PORT_MISMATCH');
    const credentials:string[]=[];for(const [slot,secret] of Object.entries(recipe.secrets)){Check.require(secret.file==='.cordis/credentials/'+slot,'INVALID_SECRET_REFERENCE');credentials.push('secret://'+slot);}
    Check.require(CanonicalJson.stringify(credentials.sort())===CanonicalJson.stringify([...configuration.credentialReferences].sort()),'INVALID_SECRET_REFERENCE');
  }
  private descriptor(directory:SafeDirectory,value:unknown,mediaType:string):{digest:string;size:number;object:Record<string,unknown>} {
    const descriptor=StrictJson.object(value);Check.require(descriptor.mediaType===mediaType&&typeof descriptor.digest==='string'&&/^sha256:[a-f0-9]{64}$/.test(descriptor.digest)&&typeof descriptor.size==='number'&&Number.isSafeInteger(descriptor.size)&&descriptor.size>=0,'OCI_DESCRIPTOR');
    const digest=descriptor.digest.slice(7),bytes=directory.file('blobs/sha256/'+digest,digest,4*1024*1024);Check.require(bytes.length===descriptor.size,'OCI_SIZE');return {digest,size:bytes.length,object:StrictJson.object(StrictJson.parse(bytes))};
  }
  protected image(bundle:SafeDirectory,image:ReleaseInventory['images'][number],installed=false):DeploymentPlan['artifacts'][number] {
    const directory=bundle.directory(image.layout);
    try {
      const layout=StrictJson.object(StrictJson.parse(directory.file('oci-layout')));Check.require(layout.imageLayoutVersion==='1.0.0','OCI_LAYOUT');
      const index=StrictJson.object(StrictJson.parse(directory.file('index.json',image.indexSha256)));Check.require(index.schemaVersion===2&&Array.isArray(index.manifests),'OCI_INDEX');
      let selected:unknown=null;for(const value of index.manifests){const candidate=StrictJson.object(value);if(candidate.digest==='sha256:'+image.manifestDigest){Check.require(selected===null,'OCI_AMBIGUOUS');selected=candidate;const platform=StrictJson.object(candidate.platform);Check.require(platform.os==='linux'&&platform.architecture==='amd64'&&!platform.variant,'IMAGE_ARCHITECTURE');}}
      Check.require(selected,'OCI_SELECTION');const manifest=this.descriptor(directory,selected,'application/vnd.oci.image.manifest.v1+json');Check.require(manifest.object.schemaVersion===2&&Array.isArray(manifest.object.layers),'OCI_MANIFEST');
      const config=this.descriptor(directory,manifest.object.config,'application/vnd.oci.image.config.v1+json');Check.require(config.object.os==='linux'&&config.object.architecture==='amd64'&&!config.object.variant,'IMAGE_ARCHITECTURE');
      const rootfs=StrictJson.object(config.object.rootfs);Check.require(rootfs.type==='layers'&&Array.isArray(rootfs.diff_ids)&&rootfs.diff_ids.length===manifest.object.layers.length,'OCI_ROOTFS');
      const layers:string[]=[];for(const value of manifest.object.layers){const layer=StrictJson.object(value);Check.require(['application/vnd.oci.image.layer.v1.tar','application/vnd.oci.image.layer.v1.tar+gzip','application/vnd.oci.image.layer.v1.tar+zstd'].includes(String(layer.mediaType))&&typeof layer.digest==='string'&&/^sha256:[a-f0-9]{64}$/.test(layer.digest)&&typeof layer.size==='number'&&Number.isSafeInteger(layer.size)&&layer.size>=0,'OCI_LAYER');if(installed)Check.require(layer.size<=512*1024*1024,'OCI_LAYER_LIMIT');const digest=layer.digest.slice(7);directory.hash('blobs/sha256/'+digest,digest,layer.size);layers.push(digest);}
      for(const diffId of rootfs.diff_ids)Check.require(typeof diffId==='string'&&/^sha256:[a-f0-9]{64}$/.test(diffId),'OCI_ROOTFS');
      return {kind:'image',reference:image.reference,manifestDigest:manifest.digest,configDigest:config.digest,layerDigests:layers};
    }finally{directory.close();}
  }
}

/** Pure planning template validation; no secret values are generated, read or returned. */
export class ContainerTemplates {
 static slots(composition:InstalledRelease['composition']):Map<string,{role:string;definition:ContainerDefinition['slots'][string]}> {const slots=new Map<string,{role:string;definition:ContainerDefinition['slots'][string]}>();for(const service of composition.services)for(const [name,definition] of Object.entries(service.definition.slots)){Check.require(!slots.has(name),'DUPLICATE_SECRET_SLOT');slots.set(name,{role:service.role,definition});}return slots;}
 static references(value:unknown):Set<string>{const result=new Set<string>();this.walk(value,result);return result;}
 private static walk(value:unknown,result:Set<string>):void {if(value===null||typeof value==='number'||typeof value==='boolean')return;if(typeof value==='string'){Check.require(!value.includes('${')&&!value.includes('\0'),'RECIPE_INTERPOLATION');return;}if(Array.isArray(value)){for(const item of value)this.walk(item,result);return;}const object=StrictJson.object(value),keys=Object.keys(object);if(keys.some(ContainerTemplates.marker)){Check.require(keys.length===1,'INVALID_TEMPLATE');const key=keys[0]!,entry=object[key];if(key==='$secret'){Check.require(PlatformSchemas.slot.safeParse(entry).success,'INVALID_SECRET_REFERENCE');result.add(entry as string);return;}if(key==='$origin'){Check.require(typeof entry==='string'&&(entry===''||/^\/(?!\/)(?!.*\.\.)[a-zA-Z0-9_./-]*$/.test(entry)),'INVALID_TEMPLATE');return;}if(key==='$uid'||key==='$hostname'||key==='$originAuthority'||key==='$originPort'||key==='$installationId'||key==='$assetDigest'){Check.require(entry===true,'INVALID_TEMPLATE');return;}if(key==='$template'){Check.require(Array.isArray(entry),'INVALID_TEMPLATE');for(const item of entry)this.walk(item,result);return;}Check.block('INVALID_TEMPLATE');}for(const entry of Object.values(object))this.walk(entry,result);}
 private static marker(value:string):boolean{return value.startsWith('$');}
 static validate(composition:InstalledRelease['composition'],configuration:DeploymentConfiguration,recipe:DeploymentRecipe):void {
  const slots=this.slots(composition),edges=new Map<string,string[]>();for(const [name,entry] of slots){const references=entry.definition.value===undefined?new Set<string>():this.references(entry.definition.value);for(const reference of references)Check.require(slots.has(reference),'MISSING_SECRET');edges.set(name,[...references]);}new DependencyGraph(edges).validate();
  const names=[...slots.keys()].sort();Check.require(CanonicalJson.stringify(names)===CanonicalJson.stringify(Object.keys(recipe.secrets).sort())&&CanonicalJson.stringify(names.map(ContainerTemplates.reference))===CanonicalJson.stringify([...configuration.credentialReferences].sort()),'INVALID_SECRET_REFERENCE');
  Check.require(Object.keys(recipe.services).sort().join(',')==='api,database,edge,identity'&&configuration.origin.startsWith('https://'),'INSTALLED_PROFILE_MISMATCH');const volumes=new Set<string>();
  for(const service of composition.services){const definition=InstalledSchemas.definition.parse(service.definition),actual=recipe.services[service.role];Check.require(definition.role===service.role&&actual&&(!definition.service.workerSocket||service.role==='api'),'SERVICE_RECIPE_MISMATCH');
   const mounts=actual.volumes??[];Check.require(mounts.length===definition.service.volumes.length,'SERVICE_RECIPE_MISMATCH');for(const mount of definition.service.volumes){Check.require(mounts.some(ContainerTemplates.volume.bind(null,mount))&&!mount.target.includes('..')&&!mount.target.includes('$'),'SERVICE_RECIPE_MISMATCH');volumes.add(mount.source);}
   Check.require(CanonicalJson.stringify([...(actual.secrets??[])].sort())===CanonicalJson.stringify(definition.service.secrets.map(ContainerTemplates.source).sort()),'SERVICE_RECIPE_MISMATCH');for(const secret of definition.service.secrets){Check.require(slots.has(secret.source)&&slots.get(secret.source)!.role===service.role&&!secret.target.includes('..')&&!secret.target.includes('$'),'SERVICE_RECIPE_MISMATCH');}
   const ports=actual.ports??[];Check.require(definition.service.portTarget===null?ports.length===0:ports.length===1&&ports[0]!.target===definition.service.portTarget,'SERVICE_RECIPE_MISMATCH');if(definition.readiness.kind!=='postgres-query')Check.require(this.references(definition.readiness.expected).size===0,'SECRET_IN_PUBLIC_OUTPUT');else Check.require(service.role==='database','INVALID_READINESS');
   for(const [slot,entry] of Object.entries(definition.slots)){if(entry.value!==undefined)for(const reference of this.references(entry.value)){const owner=slots.get(reference)!.role;Check.require(owner===service.role||this.depends(composition,service.role,owner,new Set()),'SECRET_SCOPE_MISMATCH');}Check.require(PlatformSchemas.slot.safeParse(slot).success,'INVALID_SECRET_REFERENCE');}
  }Check.require(CanonicalJson.stringify([...volumes].sort())===CanonicalJson.stringify(Object.keys(recipe.volumes).sort()),'UNUSED_RECIPE_INPUT');
 }
 private static reference(name:string):string{return 'secret://'+name;}
 private static source(value:{source:string}):string{return value.source;}
 private static volume(expected:{source:string;target:string;readOnly:boolean},actual:NonNullable<DeploymentRecipe['services'][string]['volumes']>[number]):boolean{return actual.source===expected.source&&actual.target===expected.target&&(actual.read_only??false)===expected.readOnly;}
 private static depends(composition:InstalledRelease['composition'],from:string,to:string,visited:Set<string>):boolean {if(visited.has(from))return false;visited.add(from);for(const service of composition.services)if(service.role===from)for(const dependency of service.provider.inject){if(dependency==='container.'+to)return true;if(dependency.startsWith('container.')&&this.depends(composition,dependency.slice(10),to,visited))return true;}return false;}
 static resolve(value:unknown,configuration:DeploymentConfiguration,assetDigest:string,secrets:Map<string,string>,privateValues=true):unknown {
  if(value===null||typeof value==='string'||typeof value==='number'||typeof value==='boolean')return value;if(Array.isArray(value)){const result:unknown[]=[];for(const item of value)result.push(this.resolve(item,configuration,assetDigest,secrets,privateValues));return result;}const object=StrictJson.object(value),keys=Object.keys(object);if(keys.length===1){if(Object.hasOwn(object,'$secret')){Check.require(privateValues&&typeof object.$secret==='string'&&secrets.has(object.$secret),'MISSING_SECRET');return secrets.get(object.$secret);}if(Object.hasOwn(object,'$origin'))return configuration.origin+String(object.$origin);if(object.$uid===true)return process.getuid!();if(object.$hostname===true)return new URL(configuration.origin).hostname;if(object.$originAuthority===true)return new URL(configuration.origin).host;if(object.$originPort===true)return new URL(configuration.origin).port||'443';if(object.$installationId===true)return configuration.installationId;if(object.$assetDigest===true)return assetDigest;if(Array.isArray(object.$template)){let result='';for(const part of object.$template){const item=this.resolve(part,configuration,assetDigest,secrets,privateValues);Check.require(typeof item==='string'||typeof item==='number','INVALID_TEMPLATE');result+=String(item);}return result;}}const result:Record<string,unknown>={};for(const [key,item] of Object.entries(object))Object.defineProperty(result,key,{value:this.resolve(item,configuration,assetDigest,secrets,privateValues),enumerable:true});return result;
 }
}


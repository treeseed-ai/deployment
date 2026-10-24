import { createHash } from 'node:crypto';
import { Parser, type ReadEntry } from 'tar';
import { satisfies, valid } from 'semver';
import { PlatformSchemas, CanonicalJson, PlanningBlockedError, type DeploymentConfiguration, type DeploymentPlan, type ReleaseInventory, type DeploymentRecipe, type PluginMetadata } from '@treeseed-cordis/sdk';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';

class ArchiveMetadata {
  readonly parser:Parser;
  readonly paths=new Set<string>();
  metadata:unknown=null;
  failure=false;
  bytes=0;
  chunks:Buffer[]=[];
  resolveResult:((value:Record<string,unknown>)=>void)|null=null;
  rejectResult:((error:Error)=>void)|null=null;
  constructor(readonly archive:Buffer) {this.parser=new Parser({strict:true,maxMetaEntrySize:1024*1024,maxDecompressionRatio:1000,onReadEntry:this.entry.bind(this)});}
  read():Promise<Record<string,unknown>> {return new Promise(this.start.bind(this));}
  private start(resolve:(value:Record<string,unknown>)=>void,reject:(error:Error)=>void):void {this.resolveResult=resolve;this.rejectResult=reject;this.parser.once('error',this.error.bind(this));this.parser.once('end',this.end.bind(this));this.parser.end(this.archive);}
  private entry(entry:ReadEntry):void {
    const path=entry.path.replace(/\/$/,'');
    if(!path.startsWith('package/')&&path!=='package')this.failure=true;
    if(!path.split('/').every(SafeDirectory.segment)||this.paths.has(path)||!['File','Directory','OldFile'].includes(entry.type))this.failure=true;
    this.paths.add(path);this.bytes+=entry.size;
    if(this.paths.size>100000||this.bytes>1024**3)this.failure=true;
    if(path==='package/package.json'&&entry.type==='File'&&entry.size<=1024*1024){entry.on('data',this.data.bind(this));entry.once('end',this.metadataEnd.bind(this));}
    else entry.resume();
  }
  private data(value:Buffer):void {this.chunks.push(value);}
  private metadataEnd():void {try{this.metadata=StrictJson.parse(Buffer.concat(this.chunks));}catch{this.failure=true;}}
  private error():void {this.rejectResult!(new PlanningBlockedError([{code:'INVALID_ARCHIVE',message:'Package archive inspection failed.'}]));}
  private end():void {try{Check.require(!this.failure&&this.metadata,'INVALID_ARCHIVE');this.resolveResult!(StrictJson.object(this.metadata));}catch(error){this.rejectResult!(error as Error);}}
}
class DependencyGraph {
  readonly visiting=new Set<string>();
  readonly visited=new Set<string>();
  constructor(readonly edges:Map<string,string[]>) {}
  validate():void {for(const name of this.edges.keys())this.visit(name);}
  private visit(name:string):void {Check.require(this.edges.has(name),'MISSING_SERVICE');Check.require(!this.visiting.has(name),'DEPENDENCY_CYCLE');if(this.visited.has(name))return;this.visiting.add(name);for(const dependency of this.edges.get(name)!)this.visit(dependency);this.visiting.delete(name);this.visited.add(name);}
}
interface PackageData {entry:ReleaseInventory['packages'][number];metadata:Record<string,unknown>;bytes:Buffer;}
export interface ArtifactResolution {inventory:ReleaseInventory;recipe:DeploymentRecipe;pluginBindings:PluginMetadata[];artifacts:DeploymentPlan['artifacts'];releaseDigest:string;lockDigest:string;recipeDigest:string;}
export class ArtifactResolver {
  async resolve(configuration:DeploymentConfiguration):Promise<ArtifactResolution> {
    const directory=SafeDirectory.open(configuration.release.directory);
    try {
      const releaseBytes=directory.file('release.json',configuration.release.manifestDigest),inventory=this.schema(PlatformSchemas.release.safeParse(StrictJson.parse(releaseBytes)));
      const root=StrictJson.object(StrictJson.parse(directory.file(inventory.packageJson.path,inventory.packageJson.sha256)));
      const lock=StrictJson.object(StrictJson.parse(directory.file(inventory.lockfile.path,inventory.lockfile.sha256),true));
      const recipe=this.schema(PlatformSchemas.recipe.safeParse(StrictJson.parse(directory.file(inventory.recipe.path,inventory.recipe.sha256))));
      Check.require(inventory.packages.length<=256&&inventory.images.length<=64,'INVENTORY_LIMIT');
      const packages=new Map<string,PackageData>(),paths=new Set<string>();
      for(const entry of inventory.packages){Check.require(!packages.has(entry.name)&&!paths.has(entry.path)&&valid(entry.version),'DUPLICATE_PACKAGE');paths.add(entry.path);const bytes=directory.file(entry.path,entry.sha256),metadata=await new ArchiveMetadata(bytes).read();Check.require(metadata.name===entry.name&&metadata.version===entry.version,'PACKAGE_IDENTITY');packages.set(entry.name,{entry,bytes,metadata});}
      this.lock(root,lock,packages);const pluginBindings=this.plugins(configuration,inventory,packages);this.recipe(configuration,inventory,recipe);
      const artifacts:DeploymentPlan['artifacts']=[];
      for(const name of [...packages.keys()].sort()){const entry=packages.get(name)!.entry;artifacts.push({kind:'package',name:entry.name,version:entry.version,sha256:entry.sha256});}
      const images=[...inventory.images];images.sort(ArtifactResolver.imageOrder);
      for(const image of images)artifacts.push(this.image(directory,image));
      directory.verify();
      return {inventory,recipe,pluginBindings,artifacts,releaseDigest:configuration.release.manifestDigest,lockDigest:inventory.lockfile.sha256,recipeDigest:inventory.recipe.sha256};
    }catch(error){if(error instanceof PlanningBlockedError)throw error;return Check.block('INVALID_RELEASE');}finally{directory.close();}
  }
  static imageOrder(a:ReleaseInventory['images'][number],b:ReleaseInventory['images'][number]):number {return a.reference.localeCompare(b.reference);}
  private schema<T>(result:{success:true;data:T}|{success:false}):T {Check.require(result.success,'INVALID_RELEASE_SCHEMA');return result.data;}
  private fields(value:unknown):Record<string,unknown> {return value===undefined?{}:StrictJson.object(value);}
  private unsupported(metadata:Record<string,unknown>):void {
    for(const key of ['optionalDependencies','overrides','resolutions','workspaces','bundledDependencies','bundleDependencies','peerDependenciesMeta'])if(metadata[key]!==undefined)Check.require(Object.keys(this.fields(metadata[key])).length===0,'UNSUPPORTED_DEPENDENCIES');
  }
  private lock(root:Record<string,unknown>,lock:Record<string,unknown>,packages:Map<string,PackageData>):void {
    this.unsupported(root);Check.require(lock.lockfileVersion===2&&lock.configVersion===1,'UNSUPPORTED_LOCK');
    const workspaces=StrictJson.object(lock.workspaces);Check.require(Object.keys(workspaces).length===1&&workspaces[''],'UNSUPPORTED_WORKSPACE');
    const workspace=StrictJson.object(workspaces['']),dependencies=this.fields(root.dependencies);
    Check.require(CanonicalJson.stringify(dependencies)===CanonicalJson.stringify(this.fields(workspace.dependencies)),'LOCK_ROOT_MISMATCH');
    const records=StrictJson.object(lock.packages);Check.require(Object.keys(records).length===packages.size,'LOCK_CLOSURE');
    const queue=Object.keys(dependencies),visited=new Set<string>();
    for(const name of queue){const data=packages.get(name);Check.require(data,'MISSING_PACKAGE');const range=dependencies[name];Check.require(typeof range==='string'&&(range==='file:'+data.entry.path||satisfies(data.entry.version,range)),'DEPENDENCY_VERSION');}
    while(queue.length){const name=queue.shift()!;if(visited.has(name))continue;visited.add(name);const data=packages.get(name);Check.require(data,'MISSING_PACKAGE');this.unsupported(data.metadata);
      const record=records[name];Check.require(Array.isArray(record)&&(record.length===3||record.length===4),'UNSUPPORTED_LOCK_ENTRY');
      const locator=record[0],local=record.length===3;
      Check.require(locator===(local?name+'@'+data.entry.path:name+'@'+data.entry.version),'LOCK_PACKAGE_IDENTITY');
      if(!local)Check.require(typeof record[1]==='string'&&(record[1]===''||/^https:\/\//.test(record[1])),'UNSUPPORTED_LOCK_ENTRY');
      const meta=StrictJson.object(record[local?1:2]),integrity=record[record.length-1];Check.require(typeof integrity==='string'&&/^sha(256|512)-[a-zA-Z0-9+/]+=*$/.test(integrity),'LOCK_INTEGRITY');
      const algorithm=integrity.startsWith('sha512-')?'sha512':'sha256';Check.require(createHash(algorithm).update(data.bytes).digest('base64')===integrity.slice(algorithm.length+1),'LOCK_INTEGRITY');
      for(const field of ['dependencies','peerDependencies']){
        const declared=this.fields(data.metadata[field]);Check.require(CanonicalJson.stringify(declared)===CanonicalJson.stringify(this.fields(meta[field])),'LOCK_METADATA_MISMATCH');
        for(const [dependency,range] of Object.entries(declared)){const target=packages.get(dependency);Check.require(typeof range==='string'&&target&&satisfies(target.entry.version,range),'DEPENDENCY_VERSION');queue.push(dependency);}
      }
      this.unsupported(meta);
    }
    Check.require(visited.size===packages.size,'UNUSED_PACKAGE');
  }
  private plugins(configuration:DeploymentConfiguration,inventory:ReleaseInventory,packages:Map<string,PackageData>):PluginMetadata[] {
    const selected=new Map<string,PluginMetadata>(),providers=new Map<string,string>(),packageNames=new Set<string>();
    for(const plugin of configuration.plugins){Check.require(!selected.has(plugin.id)&&!packageNames.has(plugin.package),'DUPLICATE_PLUGIN');packageNames.add(plugin.package);const data=packages.get(plugin.package);Check.require(data&&data.entry.version===plugin.version&&data.entry.sha256===plugin.integrity,'PLUGIN_ARTIFACT_MISMATCH');const metadata=this.schema(PlatformSchemas.pluginDefinition.safeParse(data.metadata.cordis));Check.require(metadata.id===plugin.id,'PLUGIN_IDENTITY');selected.set(plugin.id,metadata);for(const name of metadata.provide){Check.require(!providers.has(name),'DUPLICATE_SERVICE');providers.set(name,plugin.id);}}
    for(const id of inventory.requiredPluginIds)Check.require(selected.has(id),'MISSING_PLUGIN');
    for(const name of inventory.requiredServices)Check.require(providers.has(name),'MISSING_SERVICE');
    const edges=new Map<string,string[]>();for(const [id,metadata] of selected){const dependencies:string[]=[];for(const name of metadata.inject){const provider=providers.get(name);Check.require(provider,'MISSING_SERVICE');dependencies.push(provider);}edges.set(id,dependencies);}new DependencyGraph(edges).validate();return [...selected.values()];
  }
  private recipe(configuration:DeploymentConfiguration,inventory:ReleaseInventory,recipe:DeploymentRecipe):void {
    const references=new Set<string>(),ids=new Set<string>();for(const image of inventory.images){Check.require(!references.has(image.reference)&&!ids.has(image.id),'DUPLICATE_IMAGE');Check.require(image.reference.endsWith('@sha256:'+image.manifestDigest),'IMAGE_REFERENCE_MISMATCH');references.add(image.reference);ids.add(image.id);}
    const usedImages=new Set<string>(),usedVolumes=new Set<string>(),usedSecrets=new Set<string>(),ports:NonNullable<DeploymentRecipe['services'][string]['ports']>=[],edges=new Map<string,string[]>();
    for(const [name,service] of Object.entries(recipe.services)){
      Check.require(references.has(service.image),'MISSING_IMAGE');usedImages.add(service.image);edges.set(name,service.depends_on??[]);
      for(const port of service.ports??[])ports.push(port);
      for(const mount of service.volumes??[]){Check.require(Object.hasOwn(recipe.volumes,mount.source),'MISSING_VOLUME');usedVolumes.add(mount.source);}
      for(const secret of service.secrets??[]){Check.require(Object.hasOwn(recipe.secrets,secret),'MISSING_SECRET');usedSecrets.add(secret);}
    }
    new DependencyGraph(edges).validate();Check.require(usedImages.size===references.size&&usedVolumes.size===Object.keys(recipe.volumes).length&&usedSecrets.size===Object.keys(recipe.secrets).length,'UNUSED_RECIPE_INPUT');
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
  private image(bundle:SafeDirectory,image:ReleaseInventory['images'][number]):DeploymentPlan['artifacts'][number] {
    const directory=bundle.directory(image.layout);
    try {
      const layout=StrictJson.object(StrictJson.parse(directory.file('oci-layout')));Check.require(layout.imageLayoutVersion==='1.0.0','OCI_LAYOUT');
      const index=StrictJson.object(StrictJson.parse(directory.file('index.json',image.indexSha256)));Check.require(index.schemaVersion===2&&Array.isArray(index.manifests),'OCI_INDEX');
      let selected:unknown=null;for(const value of index.manifests){const candidate=StrictJson.object(value);if(candidate.digest==='sha256:'+image.manifestDigest){Check.require(selected===null,'OCI_AMBIGUOUS');selected=candidate;const platform=StrictJson.object(candidate.platform);Check.require(platform.os==='linux'&&platform.architecture==='amd64'&&!platform.variant,'IMAGE_ARCHITECTURE');}}
      Check.require(selected,'OCI_SELECTION');const manifest=this.descriptor(directory,selected,'application/vnd.oci.image.manifest.v1+json');Check.require(manifest.object.schemaVersion===2&&Array.isArray(manifest.object.layers),'OCI_MANIFEST');
      const config=this.descriptor(directory,manifest.object.config,'application/vnd.oci.image.config.v1+json');Check.require(config.object.os==='linux'&&config.object.architecture==='amd64'&&!config.object.variant,'IMAGE_ARCHITECTURE');
      const rootfs=StrictJson.object(config.object.rootfs);Check.require(rootfs.type==='layers'&&Array.isArray(rootfs.diff_ids)&&rootfs.diff_ids.length===manifest.object.layers.length,'OCI_ROOTFS');
      const layers:string[]=[];for(const value of manifest.object.layers){const layer=StrictJson.object(value);Check.require(['application/vnd.oci.image.layer.v1.tar','application/vnd.oci.image.layer.v1.tar+gzip','application/vnd.oci.image.layer.v1.tar+zstd'].includes(String(layer.mediaType))&&typeof layer.digest==='string'&&/^sha256:[a-f0-9]{64}$/.test(layer.digest)&&typeof layer.size==='number'&&Number.isSafeInteger(layer.size)&&layer.size>=0,'OCI_LAYER');const digest=layer.digest.slice(7);directory.hash('blobs/sha256/'+digest,digest,layer.size);layers.push(digest);}
      for(const diffId of rootfs.diff_ids)Check.require(typeof diffId==='string'&&/^sha256:[a-f0-9]{64}$/.test(diffId),'OCI_ROOTFS');
      return {kind:'image',reference:image.reference,manifestDigest:manifest.digest,configDigest:config.digest,layerDigests:layers};
    }finally{directory.close();}
  }
}

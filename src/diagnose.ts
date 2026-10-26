import {DockerCommands} from './docker-commands.js';
export {DockerCommands} from './docker-commands.js';
import {ServiceWorkerOwnerClient} from './service-ipc.js';
import { ServiceInstalledHost } from './service-installed.js';
import { HostSystem, TcpTableProbe } from './host-system.js';
export { HostSystem, TcpTableProbe } from './host-system.js';
import {ServicePlanStore} from './service-plan.js';
import {ServicePlanningHost} from './service-plan.js';
import { PlatformSchemas, CanonicalJson, PlanningBlockedError, type ServicePlan,ServiceSchemas,type InstalledPlan,type ApplyOptions,type DeploymentConfiguration, type DeploymentPlan, type DiagnosticConfiguration, type DiagnosticReport, type ServiceStatus, type ServiceApplicationRecord } from '@treeseed-cordis/sdk';
import { readFileSync, lstatSync, readdirSync, accessSync, statfsSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname, parse } from 'node:path';
import { createServer, type Server } from 'node:net';
import {InstalledHost,InstallationStore} from './installed.js';
import { ArtifactResolver } from './artifacts.js';
import { PlanStore, PlanningFailure as Check } from './filesystem.js';

export interface DeploymentHost { diagnose(configuration?:DiagnosticConfiguration):Promise<DiagnosticReport>; plan(configuration:DeploymentConfiguration):Promise<DeploymentPlan|InstalledPlan|ServicePlan>; apply?(planId:string,digest:string,options:ApplyOptions):Promise<ReturnType<typeof PlatformSchemas.apply.parse>>;status?(installationDirectory:string):Promise<ReturnType<typeof PlatformSchemas.status.parse>|ServiceStatus>;application?(installationDirectory:string,id:string):Promise<ReturnType<typeof PlatformSchemas.application.parse>|ServiceApplicationRecord>; }
export interface DiagnosticCommands { execute(args:string[]):string|null; }
export interface DiagnosticSystem { host():DiagnosticReport['host']; storage(path:string):StorageResult; }
export interface DiagnosticPorts { available(port:number):Promise<boolean>; }
export interface StorageResult { exists:boolean;freeBytes:number|null;code:string;message:string; }
class PortAttempt {
  readonly server:Server=createServer();
  completion:((result:boolean)=>void)|null=null;
  constructor(readonly port:number) {}
  execute(resolveResult:(value:boolean)=>void):void {
    this.completion=resolveResult;
    this.server.once('error',this.failed.bind(this));
    this.server.listen({port:this.port,host:'127.0.0.1',exclusive:true},this.listening.bind(this));
  }
  private failed():void {this.completion!(false);}
  private listening():void {this.server.close(this.closed.bind(this));}
  private closed():void {this.completion!(true);}
}
export class LoopbackProbe implements DiagnosticPorts {
  available(port:number):Promise<boolean> {const attempt=new PortAttempt(port);return new Promise<boolean>(attempt.execute.bind(attempt));}
}
export class ComposeDeploymentHost implements DeploymentHost {
  constructor(private readonly commands:DiagnosticCommands=new DockerCommands(),private readonly system:DiagnosticSystem=new HostSystem(),private readonly ports:DiagnosticPorts=new LoopbackProbe()) {}
  async diagnose(configuration:DiagnosticConfiguration={}):Promise<DiagnosticReport> {
    return this.inspect(configuration,this.ports);
  }
  private async inspect(configuration:DiagnosticConfiguration,ports:DiagnosticPorts):Promise<DiagnosticReport> {
    const options=PlatformSchemas.configuration.parse(configuration),path=resolve(options.installationDirectory??join(homedir(),'.local/share/treeseed-cordis')),port=options.port??8443;
    const host=this.system.host(),checks:DiagnosticReport['checks']=[],engine:DiagnosticReport['engine']={context:null,endpoint:null,serverVersion:null,serverArchitecture:null,composeVersion:null,cpus:null,memoryBytes:null};
    this.check(checks,'host',host.os==='linux'&&host.architecture==='x64'&&host.distribution==='ubuntu'&&host.release==='26.04','UNSUPPORTED_HOST','Ubuntu 26.04 x64 is the qualified host.');
    const context=options.context??this.commands.execute(['context','show']);
    let endpoint:string|null=null;
    if(context&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(context)) {
      engine.context=context;
      endpoint=this.parseString(this.commands.execute(['context','inspect',context,'--format','{{json .Endpoints.docker.Host}}']));
    }
    const local=endpoint!==null&&endpoint.startsWith('unix:///')&&(!process.env.DOCKER_HOST||process.env.DOCKER_HOST===endpoint);
    this.check(checks,'context',local,endpoint?'REMOTE_ENGINE':'DOCKER_UNAVAILABLE',endpoint?'Select a local Unix Docker context and remove conflicting DOCKER_HOST overrides.':'Docker CLI or selected context is unavailable.');
    if(local&&context) {
      engine.endpoint=endpoint;
      const info=this.parseObject(this.commands.execute(['--context',context,'info','--format','{{json .}}']));
      engine.serverVersion=this.string(info,'ServerVersion');engine.serverArchitecture=this.string(info,'Architecture');
      engine.cpus=this.number(info,'NCPU');engine.memoryBytes=this.number(info,'MemTotal');
      const supported=this.string(info,'OSType')==='linux'&&['x86_64','amd64'].includes(engine.serverArchitecture??'');
      this.check(checks,'engine',engine.serverVersion!==null&&supported,'ENGINE_UNAVAILABLE','A reachable Linux amd64 Docker engine is required.');
      const compose=this.parseObject(this.commands.execute(['--context',context,'compose','version','--format','json']));
      engine.composeVersion=this.string(compose,'version');
      this.check(checks,'compose',engine.composeVersion!==null,'COMPOSE_UNAVAILABLE','Docker Compose must be available in the selected context.');
      this.check(checks,'resources',(engine.cpus??0)>=2&&(engine.memoryBytes??0)>=2*1024**3,'ENGINE_RESOURCES','The engine requires at least 2 CPUs and 2 GiB memory.');
    } else {
      this.check(checks,'engine',false,'ENGINE_NOT_PROBED','Engine was not contacted because context validation failed.');
      this.check(checks,'compose',false,'COMPOSE_NOT_PROBED','Compose was not queried because context validation failed.');
      this.check(checks,'resources',false,'RESOURCES_NOT_PROBED','Engine resources were not queried.');
    }
    const storage=this.system.storage(path);
    this.check(checks,'storage',storage.code==='OK',storage.code,storage.message);
    this.check(checks,'port',await ports.available(port),'PORT_UNAVAILABLE','The selected loopback port must be available to this user.');
    let ready=true;for(const check of checks)if(check.status==='blocked')ready=false;
    return PlatformSchemas.diagnostic.parse({ready,host,engine,installation:{path,exists:storage.exists,freeBytes:storage.freeBytes},port,checks});
  }
  async plan(configuration:DeploymentConfiguration):Promise<DeploymentPlan|InstalledPlan|ServicePlan> {
    configuration=PlatformSchemas.desired.or(ServiceSchemas.configuration).parse(configuration);if(ServicePlanningHost.isRelease(configuration)){configuration=ServiceSchemas.configuration.parse(configuration);configuration.installationDirectory=resolve(configuration.installationDirectory);if(ServicePlanStore.isFormat(configuration.installationDirectory)&&new ServicePlanStore(configuration.installationDirectory).current()){const control=new ServicePlanStore(configuration.installationDirectory).directory('control');try{Check.require(control.entries().join(',')==='worker.sock','OWNER_HOST_REQUIRED');}finally{control.close();}return new ServiceWorkerOwnerClient({installationDirectory:configuration.installationDirectory}).plan(configuration);}return new ServicePlanningHost(this.commands,this.system).plan(configuration);}configuration=PlatformSchemas.desired.parse(configuration);if(InstalledHost.isRelease(configuration))return new InstalledHost(this.commands,this.system).plan(configuration);
    const options=PlatformSchemas.desired.parse(configuration);
    options.installationDirectory=resolve(options.installationDirectory);options.release.directory=resolve(options.release.directory);options.origin=new URL(options.origin).origin;
    options.plugins.sort(ComposeDeploymentHost.pluginOrder);options.credentialReferences.sort();
    const installation=options.installationDirectory,bundle=options.release.directory;
    Check.require(installation!==bundle&&!bundle.startsWith(installation+'/')&&!installation.startsWith(bundle+'/'),'OVERLAPPING_STORAGE');
    const origin=new URL(options.origin),port=Number(origin.port||(origin.protocol==='https:'?443:80));
    const report=await this.inspect({context:options.engineContext,installationDirectory:installation,port},new TcpTableProbe());
    const blockers=[];for(const check of report.checks)if(check.status==='blocked')blockers.push({code:check.code,message:check.message});if(blockers.length)throw new PlanningBlockedError(blockers);
    const resolved=await new ArtifactResolver().resolve(options);
    const info=this.parseObject(this.commands.execute(['--context',options.engineContext,'info','--format','{{json .}}']));
    const daemonId=this.string(info,'ID');Check.require(daemonId&&report.engine.endpoint&&this.string(info,'OSType')==='linux'&&['amd64','x86_64'].includes(this.string(info,'Architecture')??''),'ENGINE_IDENTITY');
    const expectedEngine:DeploymentPlan['expectedEngine']={context:options.engineContext,endpoint:report.engine.endpoint,daemonId,os:'linux',architecture:'amd64'};
    const projectName='cordis-'+CanonicalJson.digest({installationId:options.installationId,installationDirectory:installation}).slice(0,16);
    this.resources(options.engineContext,projectName);const store=new PlanStore(installation);store.inspect(options,expectedEngine);
    const effects:DeploymentPlan['effects']=[];
    for(const artifact of resolved.artifacts)effects.push({kind:artifact.kind==='package'?'stage-package':'stage-image',target:artifact.kind==='package'?artifact.name+'@'+artifact.version:artifact.reference});
    for(const credential of options.credentialReferences)effects.push({kind:'prepare-credential',target:credential});
    effects.push({kind:'create-network',target:projectName+'_default'});
    for(const name of Object.keys(resolved.recipe.volumes).sort())effects.push({kind:'create-volume',target:projectName+'_'+name});
    for(const name of Object.keys(resolved.recipe.services).sort()){effects.push({kind:'configure-service',target:name});if(options.runtimeState==='running')effects.push({kind:'start-service',target:name});}
    const payload={formatVersion:1 as const,configuration:options,recipe:resolved.recipe,pluginBindings:resolved.pluginBindings,configurationDigest:CanonicalJson.digest(options),releaseDigest:resolved.releaseDigest,recipeDigest:resolved.recipeDigest,lockDigest:resolved.lockDigest,expectedEngine,expectedComposition:null,projectName,artifacts:resolved.artifacts,effects,blockers:[]};
    const digest=CanonicalJson.digest(payload),plan=PlatformSchemas.plan.parse({...payload,id:'plan-'+digest,digest});return store.publish(plan);
  }
  apply(planId:string,digest:string,options:ApplyOptions):Promise<ReturnType<typeof PlatformSchemas.apply.parse>> {return ServicePlanStore.isFormat(options.installationDirectory)?new ServiceInstalledHost().apply(planId,digest,options):new InstalledHost(this.commands,this.system).apply(planId,digest,options);}
  status(installationDirectory:string):Promise<ReturnType<typeof PlatformSchemas.status.parse>|ServiceStatus> {return ServicePlanStore.isFormat(installationDirectory)?new ServiceInstalledHost().status(installationDirectory):new InstalledHost(this.commands,this.system).status(installationDirectory);}
  application(installationDirectory:string,id:string):Promise<ReturnType<typeof PlatformSchemas.application.parse>|ServiceApplicationRecord> {return ServicePlanStore.isFormat(installationDirectory)?new ServiceInstalledHost().application(installationDirectory,id):new InstalledHost(this.commands,this.system).application(installationDirectory,id);}
  private static pluginOrder(a:DeploymentConfiguration['plugins'][number],b:DeploymentConfiguration['plugins'][number]):number {return a.id.localeCompare(b.id);}
  private resources(context:string,project:string):void {
    for(const args of [['ps','--all','--format','{{json .}}'],['volume','ls','--format','{{json .}}'],['network','ls','--format','{{json .}}']]){
      const output=this.commands.execute(['--context',context,...args]);Check.require(output!==null,'RESOURCE_INSPECTION');
      if(output==='')continue;for(const line of output.split('\n')){const value=this.parseObject(line);Check.require(value,'RESOURCE_INSPECTION');const name=this.string(value,'Names')??this.string(value,'Name'),labels=this.string(value,'Labels')??'';Check.require(name,'RESOURCE_INSPECTION');const owned=labels.split(',').includes('com.docker.compose.project='+project);Check.require(!owned&&name!==project&&!name.startsWith(project+'_')&&!name.startsWith(project+'-'),'FOREIGN_RUNTIME');}
    }
  }
  private check(checks:DiagnosticReport['checks'],id:string,passed:boolean,code:string,message:string):void {checks.push({id,status:passed?'pass':'blocked',code:passed?'OK':code,message});}
  private parseObject(value:string|null):Record<string,unknown>|null {try{const result:unknown=JSON.parse(value??'null');return result!==null&&typeof result==='object'&&!Array.isArray(result)?result as Record<string,unknown>:null;}catch{return null;}}
  private parseString(value:string|null):string|null {try{const parsed:unknown=JSON.parse(value??'null');return typeof parsed==='string'?parsed:null;}catch{return null;}}
  private string(value:Record<string,unknown>|null,key:string):string|null {const field=value?.[key];return typeof field==='string'&&field.trim()?field:null;}
  private number(value:Record<string,unknown>|null,key:string):number|null {const field=value?.[key];return typeof field==='number'&&Number.isFinite(field)&&field>=0?field:null;}
}

export { ArtifactResolver } from './artifacts.js';
export { ServiceArtifactResolver } from './service-artifacts.js';

export { PlanStore } from './filesystem.js';

export { DeploymentCapability, DeploymentPlugin, DeploymentComposition } from './composition.js';

export {PackageArchiveMaterializer,InstallationStore,DeploymentWorkerClient,DeploymentWorker,WorkerComposition,PostgresContainerPlugin,CaddyContainerPlugin} from './installed.js';

export {ServicePlanStore} from './service-plan.js';
export {ServicePlanIdentity,ServiceTransitions} from './service-plan.js';
export {ServiceWorkerClient,ServiceWorkerOwnerClient} from './service-ipc.js';
export {ServiceHostRuntime} from './service-host.js';
export { PluginManagerToken, PluginManagerPlugin, type PluginManager } from './plugin-manager.js';
export { PluginRegistryReader } from './plugin-reader.js';
export {ServiceProviderStager,type PreparedServiceProvider} from './service-staging.js';
export {ServiceCredentials} from './service-credentials.js';
export {ServiceImages,LocalDockerCommands,type ServiceImageBinding,type ServiceImageCommands,type ServiceAuthorityCommands} from './service-images.js';

export {ServiceContainerEngine,ScopedServiceEngine,ServiceExecution,ServiceRuntimeInspection} from "./service-engine.js";

export {ServiceNativeScope,type PreparedServiceScope} from "./service-native.js";

export {ServiceApplicationRuntime,ServiceApplicationPlugin,ServiceApplicationToken,type ServiceApplicationHost} from "./service-application.js";
export {ServiceWorkerBuild} from './service-worker-build.js';

export {AuthorityArchive} from './service-export.js';
export {ServiceAuthorityExports} from './service-authority-export.js';
export {PostgresServicePlugin,PostgresReadinessPlugin} from './service-postgres.js';
export {ServiceHttpClient,type ServiceHttpRequest,type ServiceHttpRequests} from './service-http.js';
export {CaddyServicePlugin} from './service-caddy.js';
export {PackageArchiveInspector,type PackageArchiveIndex,type PackageArchiveFile} from './package-archive.js';
export {ServiceProjection} from './service-projection.js';

export {PluginRequestStore} from './plugin-registry.js';

export {ManagedSourceTools} from './managed-tools.js';

export {ManagedReleaseCache,ManagedReleaseReader} from './release-cache.js';

export {NpmSourcePlugin,NpmSourceRuntime,PackageSourceTokens,type PackageSourceResolver} from './npm-source.js';

export type {ResolvedPackageArchive} from './source-archive.js';
export { InstalledPluginManager } from './installed-plugins.js';
export { GitSourcePlugin, GitSourceRuntime, GitSourceToken } from './git-source.js';

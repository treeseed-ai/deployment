import { openSync, closeSync, fstatSync, lstatSync, constants, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { CanonicalJson, CapabilityToken, PluginSource, PluginManagementSchemas, ProviderV4Schemas, ServiceSchemas, type PluginInstallRequest, type PluginRequestRecord, type ServicePlan } from '@treeseed-cordis/sdk';
import { Context, CordisServiceLocator, type CompositionHandle } from '@treeseed-cordis/sdk/runtime';
import { InstallationAuthority, InstallationAuthorityToken } from './service-authority.js';
import { ServiceApplicationRuntime } from './service-application.js';
import type { PackageSourceResolver } from './npm-source.js';
import type { ResolvedPackageArchive } from './source-archive.js';
import { PluginRequestStore } from './plugin-registry.js';
import { ManagedReleaseCache } from './release-cache.js';
import { ManagedSourceTools } from './managed-tools.js';
import { SourceTrust } from './source-registry.js';
import { InstallationStore } from './installed.js';
import { SafeDirectory, PlanningFailure as Check } from './filesystem.js';
/** Held private Git bookkeeping; source repositories never supply local command configuration. */
class GitRepositoryGuard {
    private readonly fd:number;
    private readonly before:Stats;
    private readonly digest:string;
    constructor(readonly directory:SafeDirectory){
        this.fd=openSync(directory.childPath('config'),constants.O_RDONLY|constants.O_NOFOLLOW);
        this.before=fstatSync(this.fd);
        try{this.digest=createHash('sha256').update(directory.file('config',undefined,1024*1024,true)).digest('hex');this.verify();}catch(error){closeSync(this.fd);throw error;}
    }
    path():string{return '/proc/'+process.pid+'/fd/'+this.directory.fd;}
    verify():void{const after=fstatSync(this.fd),linked=lstatSync(this.directory.childPath('config'));Check.require(after.dev===this.before.dev&&after.ino===this.before.ino&&after.size===this.before.size&&after.mtimeMs===this.before.mtimeMs&&after.ctimeMs===this.before.ctimeMs&&linked.dev===this.before.dev&&linked.ino===this.before.ino,'GIT_CONFIGURATION_CHANGED');this.directory.file('config',this.digest,1024*1024,true);this.directory.verify();}
    close():void{closeSync(this.fd);this.directory.close();}
}
class GitSourceAdapter {
    parse(value:unknown):PackageSourceResolver{Check.require(value!==null&&typeof value==='object','INVALID_SOURCE_ADAPTER');for(const name of ['resolve','fetch','acquire'])Check.require(typeof Reflect.get(value,name)==='function','INVALID_SOURCE_ADAPTER');return value as PackageSourceResolver;}
}
export class GitSourceToken { static readonly instance=new CapabilityToken<PackageSourceResolver>('source.git',ProviderV4Schemas.version,new GitSourceAdapter()); }
class GitPackageSource implements PackageSourceResolver {
    private readonly requests:PluginRequestStore;
    constructor(private readonly authority:InstallationAuthority){this.requests=new PluginRequestStore(authority.plan,authority.writer);}
    private current(input:PluginRequestRecord):PluginRequestRecord{const intent=PluginManagementSchemas.install.parse(input.intent);for(const record of this.requests.records())if(record.requestId===input.requestId){Check.require(CanonicalJson.stringify(record.intent)===CanonicalJson.stringify(intent)&&record.intentDigest===input.intentDigest&&record.policyDigest===input.policyDigest&&record.expectedGeneration===input.expectedGeneration,'IDEMPOTENCY_CONFLICT');return record;}return Check.block('PLUGIN_REQUEST_NOT_FOUND');}
    private static patterns(ref:string|null):string[]{if(ref===null||ref==='HEAD')return ['HEAD'];if(ref.startsWith('refs/'))return [ref,ref+'^{}'];return ['refs/heads/'+ref,'refs/tags/'+ref,'refs/tags/'+ref+'^{}'];}
    private static commit(bytes:Buffer,patterns:string[]):string{
        const refs=new Map<string,string>(),allowed=new Set(patterns),text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
        for(const line of text.split(/\r?\n/)){if(!line)continue;const match=/^([a-f0-9]{40}|[a-f0-9]{64})\t([^\s]+)$/.exec(line);Check.require(match&&allowed.has(match[2]!)&&!refs.has(match[2]!), 'GIT_REF_IDENTITY');refs.set(match[2]!,match[1]!);}
        const bases:string[]=[];for(const name of refs.keys())if(!name.endsWith('^{}'))bases.push(name);Check.require(bases.length>0,'GIT_REF_NOT_FOUND');Check.require(bases.length===1,'GIT_REF_AMBIGUOUS');const base=bases[0]!;return refs.get(base+'^{}')??refs.get(base)!;
    }
    async resolve(input:PluginRequestRecord):Promise<PluginRequestRecord>{
        let record=this.current(input);const plan=this.authority.plan,policy=plan.acquisitionPolicy,intent=PluginManagementSchemas.install.parse(record.intent),locator=PluginSource.parse(intent.source);
        Check.require(record.operation==='install'&&policy&&plan.helpers&&record.policyDigest===CanonicalJson.digest(policy),'SOURCE_POLICY_REQUIRED');Check.require(locator.kind==='git','GIT_SOURCE_REQUIRED');
        const grants=[];for(const grant of policy.git)if(grant.origin===locator.url&&(intent.target?grant.targets.includes(intent.target):grant.targets.length===1))grants.push(grant);Check.require(grants.length===1,'GIT_SOURCE_NOT_APPROVED');const grant=grants[0]!;
        if(record.resolution?.kind==='git')return record;
        Check.require(record.stage==='received','GIT_SOURCE_RESOLUTION_UNCERTAIN');Check.require(record.expectedGeneration===(this.authority.store.current()?.compositionGeneration??null),'STALE_GENERATION');
        const helpers=[];let gitVersion:string|undefined;for(const helper of plan.helpers.helpers)if(helper.id==='git'||helper.id==='bun'){helpers.push(helper.sha256);if(helper.id==='git')gitVersion=helper.version;}Check.require(gitVersion&&helpers.length===2,'SOURCE_HELPER_UNAVAILABLE');helpers.sort();
        record=this.requests.append({...record,sequence:record.sequence+1,stage:'resolving'});
        const release=await new ManagedReleaseCache(plan).stage(this.authority.writer,record);let artifacts:SafeDirectory|undefined,work:SafeDirectory|undefined,trust:SourceTrust|undefined,repository:GitRepositoryGuard|undefined;
        try{
            artifacts=this.authority.store.directory('artifacts',this.authority.writer);const name='git-resolution-'+CanonicalJson.digest({requestId:record.requestId,intentDigest:record.intentDigest,policyDigest:record.policyDigest});Check.require(!artifacts.entries().includes(name),'GIT_SOURCE_RESOLUTION_UNCERTAIN');work=InstallationStore.mkdir(artifacts,name);
            const tools=new ManagedSourceTools(plan,this.authority.writer,policy.helperReleaseIdentity);Check.require(await tools.version('git',record)==='git version '+gitVersion,'SOURCE_HELPER_VERSION');
            const args=['--no-pager','-c','protocol.allow=never','-c','protocol.https.allow=always','-c','credential.helper=','-c','credential.interactive=false','-c','core.askPass=','-c','core.hooksPath=/dev/null','-c','http.followRedirects=false','-c','http.sslVerify=true','-c','http.proxy=','-c','http.extraHeader='];
            if(grant.certificateAuthority){const bytes=release.read(grant.certificateAuthority.path);Check.require(createHash('sha256').update(bytes).digest('hex')===grant.certificateAuthority.sha256,'SOURCE_CA_CHANGED');trust=new SourceTrust(work,bytes,grant.certificateAuthority.sha256);args.push('-c','http.sslCAInfo='+trust.path());}
            const directory=InstallationStore.mkdir(work,'repository.git');
            try{await tools.run('git',['--git-dir=/proc/'+process.pid+'/fd/'+directory.fd,'init','--bare','--template=','--initial-branch=cordis-source','--shared=0600'],work.path,record);repository=new GitRepositoryGuard(directory);}catch(error){directory.close();throw error;}
            args.unshift('--git-dir='+repository.path());
            let commit:string;
            if(locator.ref!==null&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(locator.ref))commit=locator.ref;
            else{const patterns=GitPackageSource.patterns(locator.ref),bytes=await tools.run('git',[...args,'ls-remote','--',locator.url,...patterns],work.path,record);trust?.verify();commit=GitPackageSource.commit(bytes,patterns);InstallationStore.publish(work,'lookup.json',{commit,refsDigest:createHash('sha256').update(bytes).digest('hex')});}
            repository.verify();trust?.verify();work.verify();const resolution=PluginManagementSchemas.resolution.parse({kind:'git',origin:locator.url,commit,helperDigests:helpers});return this.requests.append({...record,sequence:record.sequence+1,stage:'resolved',resolution});
        }finally{repository?.close();trust?.close();work?.close();artifacts?.close();release.close();}
    }
    async fetch(_record:PluginRequestRecord):Promise<ResolvedPackageArchive>{return Check.block('GIT_ACQUISITION_NOT_QUALIFIED');}
    async acquire(_record:PluginRequestRecord):Promise<PluginRequestRecord>{return Check.block('GIT_ACQUISITION_NOT_QUALIFIED');}
}
/** The host adopts this same native provider when Git archive/closure admission is qualified. */
export class GitSourcePlugin {
    static readonly provide=[GitSourceToken.instance.id];static readonly inject=[InstallationAuthorityToken.instance.id];static readonly Config=ServiceSchemas.plan;
    static readonly declaration=ProviderV4Schemas.declaration.parse({id:'deployment.git-source',pluginId:'deployment',capability:GitSourceToken.instance.id,contractVersion:ProviderV4Schemas.version,target:'deployment',provide:this.provide,inject:this.inject});
    constructor(context:Context,plan:ServicePlan){const authority=InstallationAuthorityToken.instance.parse(Reflect.get(context,InstallationAuthorityToken.instance.id));Check.require(CanonicalJson.stringify(authority.plan)===CanonicalJson.stringify(ServiceSchemas.plan.parse(plan)),'PLAN_BINDING');context.provide(GitSourceToken.instance.id,new GitPackageSource(authority));}
}
export class GitSourceRuntime extends ServiceApplicationRuntime implements PackageSourceResolver {
    private sourceClosed=false;
    private constructor(handle:CompositionHandle,context:Context,private readonly authority:InstallationAuthority){super(handle,context);}
    static async start(input:ServicePlan):Promise<GitSourceRuntime>{const plan=ServiceSchemas.plan.parse(input),artifact={kind:'bundled' as const,identity:'deployment-git-source.1:'+plan.composition.worker.sha256},scope=await this.mount(plan,[{token:GitSourceToken.instance,plugin:GitSourcePlugin,declaration:GitSourcePlugin.declaration,configuration:plan,artifact}]);return new GitSourceRuntime(scope.handle,scope.context,InstallationAuthorityToken.instance.parse(Reflect.get(scope.context,InstallationAuthorityToken.instance.id)));}
    begin(source:string,key:string,target:PluginInstallRequest['target']='deployment'):PluginRequestRecord{Check.require(!this.sourceClosed&&this.authority.plan.acquisitionPolicy,'SOURCE_POLICY_REQUIRED');const intent:PluginInstallRequest={source,idempotencyKey:key,installationDirectory:this.authority.plan.configuration.installationDirectory,scope:'installation',target,configuration:{}};return new PluginRequestStore(this.authority.plan,this.authority.writer).begin(intent,CanonicalJson.digest(this.authority.plan.acquisitionPolicy),this.authority.store.current()?.compositionGeneration??null).record;}
    async resolve(record:PluginRequestRecord):Promise<PluginRequestRecord>{Check.require(!this.sourceClosed,'HOST_CLOSED');const lease=await CordisServiceLocator.from(this.context).acquire(GitSourceToken.instance);try{return await lease.value.resolve(record);}finally{await lease.release();}}
    async fetch(record:PluginRequestRecord):Promise<ResolvedPackageArchive>{Check.require(!this.sourceClosed,'HOST_CLOSED');const lease=await CordisServiceLocator.from(this.context).acquire(GitSourceToken.instance);try{return await lease.value.fetch(record);}finally{await lease.release();}}
    async acquire(record:PluginRequestRecord):Promise<PluginRequestRecord>{Check.require(!this.sourceClosed,'HOST_CLOSED');const lease=await CordisServiceLocator.from(this.context).acquire(GitSourceToken.instance);try{return await lease.value.acquire(record);}finally{await lease.release();}}
    async close(timeout=10000):Promise<void>{this.sourceClosed=true;await super.close(timeout);}
}

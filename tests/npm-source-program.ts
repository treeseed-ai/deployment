import * as Deployment from '@treeseed-cordis/deployment';
import {CanonicalJson, type PluginRequestRecord, type ServicePlan} from '@treeseed-cordis/sdk';
import {createServer,type Server} from 'node:https';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
interface SourceRuntime {
    begin(source:string,key:string,target?:'deployment'|'cli'):PluginRequestRecord;
    resolve(record:PluginRequestRecord):Promise<PluginRequestRecord>;
    close():Promise<void>;
}
class RegistryFixture {
    private readonly server:Server;version='1.0.0';requests=0;authorization=false;
    constructor(private readonly root:string){this.server=createServer({key:readFileSync(join(root,'key.pem')),cert:readFileSync(join(root,'cert.pem'))},this.reply.bind(this));}
    private reply(request:IncomingMessage,response:ServerResponse):void{this.requests++;this.authorization ||= request.headers.authorization!==undefined;const versions:Record<string,unknown>={};for(const version of ['1.0.0','2.0.0']){const archive=readFileSync(join(this.root,'source-'+version+'.tgz'));versions[version]={name:'@fixture/npm-source',version,dist:{tarball:this.origin()+'source-'+version+'.tgz',integrity:'sha512-'+createHash('sha512').update(archive).digest('base64')},scripts:{postinstall:'touch MUST_NOT_RUN'}};}response.setHeader('content-type','application/json');response.end(JSON.stringify({name:'@fixture/npm-source','dist-tags':{latest:this.version},versions}));}
    origin():string{const address=this.server.address();if(!address||typeof address==='string')throw new Error('Registry not listening');return 'https://127.0.0.1:'+address.port+'/';}
    async listen():Promise<void>{await new Promise<void>(this.start.bind(this));}
    private start(done:()=>void,reject:(error:Error)=>void):void{this.server.once('error',reject);this.server.listen(0,'127.0.0.1',done);}
    async close():Promise<void>{await new Promise<void>(this.stop.bind(this));}
    private stop(done:()=>void):void{this.server.closeAllConnections();this.server.close(this.stopped.bind(this,done));}
    private stopped(done:()=>void,error?:Error):void{if(error)throw error;done();}
}
class NpmSourceProgram {
    static async run(file:string):Promise<void>{const constructor=Reflect.get(Deployment,'NpmSourceRuntime') as {start(plan:ServicePlan):Promise<SourceRuntime>};if(!constructor?.start)throw new Error('NATIVE_NPM_SOURCE_UNAVAILABLE');const input=JSON.parse(readFileSync(file,'utf8')),registry=new RegistryFixture(input.root);await registry.listen();let runtime:SourceRuntime|undefined;
        try{const configuration=input.configuration,releasePath=join(configuration.release.directory,'release.json'),release=JSON.parse(readFileSync(releasePath,'utf8'));release.acquisitionPolicy={formatVersion:1,helperReleaseIdentity:release.helpers.releaseIdentity,npm:[{registry:registry.origin(),packages:['@fixture/npm-source'],targets:['deployment'],certificateAuthority:{path:'source-ca.pem',sha256:createHash('sha256').update(readFileSync(join(configuration.release.directory,'source-ca.pem'))).digest('hex')}}],git:[],builds:[]};const bytes=CanonicalJson.stringify(release)+'\n';writeFileSync(releasePath,bytes);configuration.release.manifestDigest=createHash('sha256').update(bytes).digest('hex');const plan=await new Deployment.ComposeDeploymentHost().plan(configuration);if(plan.formatVersion!==3)throw new Error('Wrong plan');runtime=await constructor.start(plan);
            const record=runtime.begin('@fixture/npm-source','exact-npm-request'),resolved=await runtime.resolve(record);if(resolved.stage!=='resolved'||resolved.resolution?.kind!=='npm'||resolved.resolution.version!=='1.0.0'||resolved.sourceReceipt!==null)throw new Error('Missing exact resolution before acquisition');const count=registry.requests;registry.version='2.0.0';rmSync(configuration.release.directory,{recursive:true});const replay=await runtime.resolve(record);if(CanonicalJson.stringify(replay)!==CanonicalJson.stringify(resolved)||registry.requests!==count)throw new Error('Retry re-resolved mutable source');const next=await runtime.resolve(runtime.begin('@fixture/npm-source','new-npm-request'));if(next.resolution?.kind!=='npm'||next.resolution.version!=='2.0.0')throw new Error('New key did not resolve moved tag');let denied=false;try{await runtime.resolve(runtime.begin('@fixture/npm-source','denied-target','cli'));}catch{denied=true;}if(!denied||registry.requests!==count+1)throw new Error('Unapproved target performed network lookup');const uncertain=runtime.begin('@fixture/npm-source@missing','interrupted-npm-request');let failed=false;try{await runtime.resolve(uncertain);}catch{failed=true;}if(!failed)throw new Error('Missing tag was resolved');const failedCount=registry.requests;try{await runtime.resolve(uncertain);}catch{}if(registry.requests!==failedCount)throw new Error('Uncertain lookup silently retried');
            if(registry.authorization||existsSync(join(input.root,'MUST_NOT_RUN'))||existsSync(configuration.installationDirectory+'/.cordis/credentials'))throw new Error('Credentials or lifecycle canary escaped');process.stdout.write(JSON.stringify({fixture:true,native:true,exact:true,pinnedRetry:true,movedNewKey:true,sourceFree:true,grantRefused:true,noCredentialsOrScripts:true})+'\n');
        }finally{await runtime?.close();await registry.close();}}
}
await NpmSourceProgram.run(process.argv[2]!);

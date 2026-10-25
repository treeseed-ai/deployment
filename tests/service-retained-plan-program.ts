import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,statSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {Socket} from 'node:net';
import {CanonicalJson,ServiceSchemas,ServiceWorkerSchemas,PlanningBlockedError,type ServicePlan} from '@treeseed-cordis/sdk';
import {ComposeDeploymentHost,ServiceHostRuntime,ServiceWorkerOwnerClient,ServicePlanStore,ServiceCredentials,ServiceAuthorityExports,ServiceProjection} from '@treeseed-cordis/deployment';
import {RuntimeContainerFixture} from './service-fixture-plugins.js';
/** Malicious observer-frame attempt; deliberately bypasses the read-only client's local guard. */
class ObserverPlanningAttempt {
    private readonly socket=new Socket();private bytes=Buffer.alloc(0);private accept:((value:unknown)=>void)|undefined;private reject:((error:Error)=>void)|undefined;
    constructor(private readonly path:string,private readonly configuration:ServicePlan['configuration']){}
    run():Promise<unknown>{return new Promise(this.start.bind(this));}
    private start(accept:(value:unknown)=>void,reject:(error:Error)=>void):void{this.accept=accept;this.reject=reject;this.socket.setTimeout(5000);this.socket.once('timeout',this.failed.bind(this));this.socket.once('error',this.failed.bind(this));this.socket.on('data',this.data.bind(this));this.socket.once('end',this.end.bind(this));this.socket.connect(this.path,this.connected.bind(this));}
    private connected():void{this.socket.write(CanonicalJson.stringify({protocol:3,operation:'plan',configuration:this.configuration})+'\n');}
    private data(value:Buffer):void{this.bytes=Buffer.concat([this.bytes,value]);if(this.bytes.length>65536)this.failed();}
    private end():void{try{this.accept!(ServiceWorkerSchemas.response.parse(JSON.parse(this.bytes.toString())));this.socket.destroy();}catch{this.failed();}}
    private failed():void{this.socket.destroy();this.reject!(new Error('Observer denial fixture failed'));}
}
class RetainedPlanProgram {
    private static sha(bytes:Uint8Array):string{return createHash('sha256').update(bytes).digest('hex');}
    private static require(value:unknown):asserts value{if(!value)throw new Error('Retained planning qualification failed');}
    private static write(file:string,value:unknown):string{const bytes=CanonicalJson.stringify(value)+'\n';writeFileSync(file,bytes);return this.sha(Buffer.from(bytes));}
    private static credentials(plan:ServicePlan):string{const reader=new ServiceCredentials(plan),identities:Record<string,string>={};for(const service of plan.composition.services)for(const slot of Object.keys(service.resources.slots))identities[service.serviceId+':'+slot]=this.sha(reader.read(service.serviceId,'secret://'+service.serviceId+'/'+slot));return CanonicalJson.digest(identities);}
    private static plans(store:ServicePlanStore):string{const directory=join(store.path,'.cordis/plans'),files:Record<string,string>={};for(const name of readdirSync(directory))files[name]=this.sha(readFileSync(join(directory,name)));return CanonicalJson.digest(files);}
    private static async blocked(configuration:ServicePlan['configuration'],code?:string):Promise<void>{let caught:unknown;try{await new ComposeDeploymentHost().plan(configuration);}catch(error){caught=error;}this.require(caught instanceof PlanningBlockedError);if(code)this.require(caught.blockers.some(this.code.bind(null,code)));}
    private static code(expected:string,value:{code:string}):boolean{return value.code===expected;}
    private static delay(done:(value:void)=>void):void{setTimeout(done,50);}
    static async run(file:string):Promise<void>{
        const configuration=ServiceSchemas.configuration.parse(JSON.parse(readFileSync(file,'utf8'))),first=await new ComposeDeploymentHost().plan(configuration);this.require(first.formatVersion===3);const root=await ServiceHostRuntime.start(first),owner=new ServiceWorkerOwnerClient({installationDirectory:configuration.installationDirectory});
        try{
            const submitted=await owner.submit({protocol:3,operation:'submit',planId:first.id,digest:first.digest,idempotencyKey:'retained-planning-initial'}),deadline=Date.now()+120000;let record=await owner.application(submitted.id);while(!['completed','failed','cancelled'].includes(record.phase)&&Date.now()<deadline){await new Promise(this.delay);record=await owner.application(submitted.id);}this.require(record.phase==='completed'&&record.result==='ready'&&(await owner.status()).ready);
            const store=new ServicePlanStore(configuration.installationDirectory),current=store.current()!,before=CanonicalJson.stringify({current,resources:store.resources(),records:store.records()}),credentials=this.credentials(first),authorities=new ServiceAuthorityExports(first),ca=await authorities.read('instance-0','secret://instance-0/public-ca',{deadline:Date.now()+10000,signal:new AbortController().signal});
            const release=ServiceSchemas.release.parse(JSON.parse(readFileSync(join(configuration.release.directory,'release.json'),'utf8'))),service=structuredClone(release.composition.services[2]!);service.serviceId='instance-5';service.bindings=[{...service.bindings[0]!,bindingId:'instance-5'}];service.dependencies=[];service.provider={...service.provider,providerId:RuntimeContainerFixture.declaration.id,classExport:RuntimeContainerFixture.name};service.readiness={...service.readiness,endpoint:{...service.readiness.endpoint,serviceId:'instance-5'},credentialReferences:[]};
            // Use the ordinary protocol probe, not the authority-specific fixture, for this new private service.
            service.readiness.provider={...first.composition.services[0]!.readiness.provider,providerId:'fixture.probe',classExport:'ProbeFixture'};
            release.composition.services.push(service);release.composition.profile.requiredBindings.push('instance-5');const projection=ServiceProjection.resolve(service,RuntimeContainerFixture.container,release.composition,configuration);service.definition=projection.definition;service.resources=projection.resources;service.transitionPolicy=RuntimeContainerFixture.container.transitionPolicy;
            const recipe=JSON.parse(readFileSync(join(configuration.release.directory,'compose.json'),'utf8')),spec:{image:string;volumes:unknown[];secrets:string[]}={image:recipe.services['instance-0'].image,volumes:[],secrets:[]};
            for(const mount of service.definition.volumes){const key='r-'+CanonicalJson.digest({serviceId:service.serviceId,slot:mount.source}).slice(0,48);recipe.volumes[key]={};spec.volumes.push({type:'volume',source:key,target:mount.target,read_only:mount.readOnly});}
            for(const slot of Object.keys(service.resources.slots)){const key='r-'+CanonicalJson.digest({serviceId:service.serviceId,slot}).slice(0,48);recipe.secrets[key]={file:'.cordis/credentials/'+service.serviceId+'/'+slot};configuration.credentialReferences.push('secret://'+service.serviceId+'/'+slot);}
            for(const secret of service.definition.secrets)spec.secrets.push('r-'+CanonicalJson.digest({serviceId:service.serviceId,slot:secret.slot}).slice(0,48));recipe.services[service.serviceId]=spec;
            release.recipe.sha256=this.write(join(configuration.release.directory,'compose.json'),recipe);configuration.release.manifestDigest=this.write(join(configuration.release.directory,'release.json'),release);
            const next=await new ComposeDeploymentHost().plan(configuration);this.require(next.formatVersion===3&&next.expectedComposition===first.compositionGeneration&&next.expectedResourceSet===CanonicalJson.digest(current.resources)&&CanonicalJson.stringify(next.retainedResources)===CanonicalJson.stringify(current.resources));
            const starts:string[]=[];for(const effect of next.effects)if(effect.kind==='start-service')starts.push(effect.target);this.require(starts.join(',')==='instance-5');let retained=0,added=0;for(const change of next.changes){const prior=first.changes.find(this.named.bind(null,change.serviceId));if(prior){this.require(change.kind==='retain'&&change.serviceGeneration===prior.serviceGeneration&&change.previousGeneration===prior.serviceGeneration&&change.requiredActions.length===0);retained++;}else{this.require(change.serviceId==='instance-5'&&change.kind==='add');added++;}}this.require(retained===5&&added===1);
            const repeat=await new ComposeDeploymentHost().plan(configuration);this.require(repeat.digest===next.digest&&CanonicalJson.stringify(store.read(next.id,next.digest))===CanonicalJson.stringify(next)&&(statSync(join(configuration.installationDirectory,'.cordis/plans',next.id+'.json')).mode&0o777)===0o600);
            const files=this.plans(store),denied=ServiceWorkerSchemas.response.parse(await new ObserverPlanningAttempt(join(configuration.installationDirectory,'.cordis/run/host.sock'),configuration).run());this.require(!denied.success&&denied.blockers.some(this.code.bind(null,'OBSERVER_OPERATION_REFUSED')));
            await this.blocked({...configuration,installationId:'foreign-scope'},'TRANSITION_SCOPE');await this.blocked({...configuration,runtimeState:'stopped'},'RUNTIME_STATE_TRANSITION_UNSUPPORTED');const archive=join(configuration.release.directory,release.packages[0]!.path),bytes=readFileSync(archive);try{writeFileSync(archive,Buffer.concat([bytes,Buffer.from('tamper-canary')]));await this.blocked(configuration);}finally{writeFileSync(archive,bytes);}this.require(this.plans(store)===files);
            this.require((await owner.status()).ready&&before===CanonicalJson.stringify({current:store.current(),resources:store.resources(),records:store.records()})&&credentials===this.credentials(first)&&(await authorities.read('instance-0','secret://instance-0/public-ca',{deadline:Date.now()+10000,signal:new AbortController().signal})).equals(ca));
            await root.close();await this.blocked(configuration,'OWNER_HOST_REQUIRED');this.require(this.plans(store)===files);
            process.stdout.write(JSON.stringify({fixtureOnly:true,retained:5,planned:1,active:5,unchanged:true,deterministic:true})+'\n');
        }finally{await root.close();}
    }
    private static named(id:string,value:{serviceId:string}):boolean{return id===value.serviceId;}
}
await RetainedPlanProgram.run(process.argv[2]!);

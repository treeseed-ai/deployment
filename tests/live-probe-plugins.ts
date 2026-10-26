import{Context}from'cordis';
import{existsSync,writeFileSync}from'node:fs';
import{CanonicalJson,PlatformSchemas,ProviderV4Schemas,ServiceTokens,type ProbeContext,type ServiceReadiness}from'@treeseed-cordis/sdk';
import{ProbeFixture}from'./service-fixture-plugins.js';
interface LifecycleFiles{disposed:string;mounted:string;}
export class LiveProbeOld{
    static readonly provide=ProbeFixture.provide;static readonly inject=ProbeFixture.inject;static readonly probe=ProbeFixture.probe;
    static readonly Config=PlatformSchemas.empty.extend({disposed:PlatformSchemas.absolute,mounted:PlatformSchemas.absolute});
    static readonly declaration=ProviderV4Schemas.declaration.parse({...ProbeFixture.declaration,id:'fixture-live.old',pluginId:'fixture-live'});
    static readonly replacement={kind:'live',stateVersion:1,qualificationDigest:CanonicalJson.digest({fixtureOnly:true,qualification:'native-probe-lease-drain.1'})};
    constructor(context:Context,protected readonly files:LifecycleFiles){context.provide(ServiceTokens.probe().id,this);context.effect(this.effect.bind(this));}
    async observe(context:ProbeContext):Promise<ServiceReadiness>{const response=await fetch(context.endpoint,{signal:context.signal});return {serviceId:context.serviceId,ready:response.ok,observations:[response.ok?'fixture.live.old.ready':'fixture.live.old.blocked']};}
    private effect():()=>void{return this.disposed.bind(this);}
    private disposed():void{writeFileSync(this.files.disposed,'disposed');}
}
export class LiveProbeNext extends LiveProbeOld{
    static override readonly declaration=ProviderV4Schemas.declaration.parse({...LiveProbeOld.declaration,id:'fixture-live.next'});
    constructor(context:Context,files:LifecycleFiles){super(context,files);if(!existsSync(files.disposed))throw new Error('PRIOR_NATIVE_DISPOSAL_NOT_AWAITED');writeFileSync(files.mounted,'mounted');}
    override async observe(context:ProbeContext):Promise<ServiceReadiness>{const result=await super.observe(context);return {...result,observations:[...result.observations,'fixture.live.next']};}
}

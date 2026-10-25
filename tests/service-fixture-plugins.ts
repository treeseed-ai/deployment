import {Service,type Context} from 'cordis';
import {PlatformSchemas,ProviderV4Schemas,ServiceTokens,type ServiceEngine,type ServiceExecutionContext,type ServiceIdentity,type ServiceReadiness,type ProbeContext} from '@treeseed-cordis/sdk';
export class ContainerFixture {
    private readonly engine:ServiceEngine;private readonly execution:ServiceExecutionContext;
    constructor(private readonly context:Context){this.engine=ServiceTokens.engine.parse(Reflect.get(context,ServiceTokens.engine.id));this.execution=ServiceTokens.context.parse(Reflect.get(context,ServiceTokens.context.id));}
    async [Service.init]():Promise<void>{await this.engine.start(this.execution.service.serviceId,this.execution.service.definition);this.context.provide(ServiceTokens.container().id,this);}
    identity():ServiceIdentity{return this.engine.identity(this.execution.service.serviceId);}
    ready():Promise<ServiceReadiness>{return this.engine.ready(this.execution.service.serviceId);}

    static readonly provide = ['container.service'];
    static readonly inject = ['service.context','deployment.services'];
    static readonly Config = PlatformSchemas.empty;
    static readonly declaration = ProviderV4Schemas.declaration.parse({ id: 'fixture.container', pluginId: 'fixture', capability: 'container.service', contractVersion: ProviderV4Schemas.version, target: 'deployment', provide: this.provide, inject: this.inject });
    static readonly replacement = { kind: 'restart', qualificationDigest: null, stateVersion: 1 };
    static readonly container = { definition: { imageId: 'application', environment: {}, ports: [{ id: 'http', target: 8080 }], volumes: [], secrets: [], workerSocket: false }, resources: { volumes: [], slots: {}, grants: [], authorities: [] }, providedContracts: [{ port: 'http', contractId: 'fixture.echo', contractVersion: '1.0.0' }], dependencies: [], observationContract: 'fixture.echo', transitionPolicy: { kind: 'additive', stateVersion: 1 } };
}
export class ProbeFixture {
    constructor(context:Context){context.provide(ServiceTokens.probe().id,this);}
    async observe(context:ProbeContext):Promise<ServiceReadiness>{const response=await fetch(context.endpoint,{signal:context.signal});return {serviceId:context.serviceId,ready:response.ok,observations:[response.ok?'fixture.echo.ready':'fixture.echo.blocked']};}

    static readonly provide = ['probe.service'];
    static readonly inject:string[] = [];
    static readonly Config = PlatformSchemas.empty;
    static readonly declaration = ProviderV4Schemas.declaration.parse({ id: 'fixture.probe', pluginId: 'fixture', capability: 'probe.service', contractVersion: ProviderV4Schemas.version, target: 'deployment', provide: this.provide, inject: this.inject });
    static readonly replacement = { kind: 'restart', qualificationDigest: null, stateVersion: 1 };
    static readonly probe = { observationContracts: ['fixture.echo'], schemes: ['http'], maximumDeadlineMs: 5000 };
}

import { X509Certificate } from 'node:crypto';
import { Service, type Context } from 'cordis';
import { PlatformSchemas, ProviderV4Schemas, PluginManagementSchemas, type PluginExportDescriptor, ServiceTokens, type ServiceEngine, type ServiceExecutionContext, type ServiceIdentity, type ServiceReadiness, type ProbeContext } from '@treeseed-cordis/sdk';
export class ContainerFixture {
    private readonly engine: ServiceEngine;
    private readonly execution: ServiceExecutionContext;
    constructor(private readonly context: Context) { this.engine = ServiceTokens.engine.parse(Reflect.get(context, ServiceTokens.engine.id)); this.execution = ServiceTokens.context.parse(Reflect.get(context, ServiceTokens.context.id)); }
    async [Service.init](): Promise<void> { await this.engine.start(this.execution.service.serviceId, this.execution.service.definition); this.context.provide(ServiceTokens.container().id, this); }
    identity(): ServiceIdentity { return this.engine.identity(this.execution.service.serviceId); }
    ready(): Promise<ServiceReadiness> { return this.engine.ready(this.execution.service.serviceId); }
    static readonly provide = ['container.service'];
    static readonly inject = ['service.context', 'deployment.services'];
    static readonly Config = PlatformSchemas.empty;
    static readonly declaration = ProviderV4Schemas.declaration.parse({ id: 'fixture.container', pluginId: 'fixture', capability: 'container.service', contractVersion: ProviderV4Schemas.version, target: 'deployment', provide: this.provide, inject: this.inject });
    static readonly replacement = { kind: 'restart', qualificationDigest: null, stateVersion: 1 };
    static readonly container: NonNullable<PluginExportDescriptor['container']> = PluginManagementSchemas.container.parse({ definition: { imageId: 'application', environment: {}, ports: [{ id: 'http', target: 8080 }], volumes: [], secrets: [], workerSocket: false }, resources: { volumes: [], slots: {}, grants: [], authorities: [] }, providedContracts: [{ port: 'http', contractId: 'fixture.echo', contractVersion: '1.0.0' }], dependencies: [], observationContract: 'fixture.echo', transitionPolicy: { kind: 'additive', stateVersion: 1 } });
}
export class ProbeFixture {
    constructor(context: Context) { context.provide(ServiceTokens.probe().id, this); }
    async observe(context: ProbeContext): Promise<ServiceReadiness> { const response = await fetch(context.endpoint, { signal: context.signal }); return { serviceId: context.serviceId, ready: response.ok, observations: [response.ok ? 'fixture.echo.ready' : 'fixture.echo.blocked'] }; }
    static readonly provide = ['probe.service'];
    static readonly inject: string[] = [];
    static readonly Config = PlatformSchemas.empty;
    static readonly declaration = ProviderV4Schemas.declaration.parse({ id: 'fixture.probe', pluginId: 'fixture', capability: 'probe.service', contractVersion: ProviderV4Schemas.version, target: 'deployment', provide: this.provide, inject: this.inject });
    static readonly replacement = { kind: 'restart', qualificationDigest: null, stateVersion: 1 };
    static readonly probe = { observationContracts: ['fixture.echo'], schemes: ['http'], maximumDeadlineMs: 5000 };
}
/** Explicit negative readiness fixture for a serving, restarted container. */
export class RestartUnreadyProbeFixture extends ProbeFixture {
    static override readonly declaration = ProviderV4Schemas.declaration.parse({...ProbeFixture.declaration,id:'fixture.restart-unready-probe'});
    override async observe(context:ProbeContext):Promise<ServiceReadiness>{return {serviceId:context.serviceId,ready:false,observations:['fixture.replacement.unready']};}
}
export class CredentialContainerFixture extends ContainerFixture {
    static override readonly declaration = ProviderV4Schemas.declaration.parse({ ...ContainerFixture.declaration, id: 'fixture.credentials' });
    static override readonly container: NonNullable<PluginExportDescriptor['container']> = PluginManagementSchemas.container.parse({ ...ContainerFixture.container, definition: { ...ContainerFixture.container.definition, secrets: [{ slot: 'password', target: '/run/cordis/password' }, { slot: 'configuration', target: '/run/cordis/configuration.json' }] }, resources: { ...ContainerFixture.container.resources, slots: { password: { kind: 'random' }, identity: { kind: 'uuid' }, configuration: { kind: 'json', value: { service: { $context: 'serviceId' }, password: { $secret: { slot: 'password' } }, origin: { $context: 'origin' } } } } } });
}
export class CredentialConsumerFixture extends ContainerFixture {
    static override readonly declaration = ProviderV4Schemas.declaration.parse({ ...ContainerFixture.declaration, id: 'fixture.credential-consumer' });
    static override readonly container: NonNullable<PluginExportDescriptor['container']> = PluginManagementSchemas.container.parse({ ...ContainerFixture.container, definition: { ...ContainerFixture.container.definition, secrets: [{ slot: 'configuration', target: '/run/cordis/configuration.json' }] }, resources: { ...ContainerFixture.container.resources, slots: { password: { kind: 'random' }, configuration: { kind: 'json', value: { primary: { $secret: { dependencyPort: 'primary', slot: 'password' } }, own: { $secret: { slot: 'password' } } } } }, grants: [{ dependencyPort: 'primary', slot: 'password' }] }, dependencies: [{ port: 'primary', contractId: 'fixture.echo', contractVersion: '1.0.0' }] });
}
export class RuntimeContainerFixture extends CredentialContainerFixture {
    static override readonly declaration = ProviderV4Schemas.declaration.parse({ ...ContainerFixture.declaration, id: 'fixture.runtime' });
    static override readonly container: NonNullable<PluginExportDescriptor['container']> = PluginManagementSchemas.container.parse({ ...CredentialContainerFixture.container, definition: { ...CredentialContainerFixture.container.definition, environment: { FIXTURE_SERVICE_ID: { $context: 'serviceId' } }, volumes: [{ source: 'data', target: '/data', readOnly: false }] }, resources: { ...CredentialContainerFixture.container.resources, volumes: ['data'] } });
}
/** Explicit probe-boundary fixture, separate from the real HTTP readiness provider. */
export class QualificationProbeFixture {
    static readonly provide = ['probe.service'];
    static readonly inject: string[] = [];
    static readonly Config = PlatformSchemas.empty;
    static readonly replacement = ProbeFixture.replacement;
    static readonly declaration = ProviderV4Schemas.declaration.parse({ ...ProbeFixture.declaration, id: 'fixture.qualification-probe' });
    static readonly probe = ProbeFixture.probe;
    private count = 0;
    private expired = false;
    constructor(context: Context) { context.provide(ServiceTokens.probe().id, this); }
    async observe(context: ProbeContext): Promise<ServiceReadiness> {
        this.count++;
        if (this.count === 1)
            return { serviceId: 'foreign', ready: true, observations: ['fixture.wrong-instance'] };
        if (this.count === 2)
            return { serviceId: context.serviceId, ready: true, observations: ['secret_canary private output'] };
        if (this.count === 3)
            return { serviceId: context.serviceId, ready: false, observations: ['fixture.false-ready'] };
        if (this.count === 4) {
            await new Promise(QualificationProbeFixture.delay);
            try {
                await context.credential('secret://' + context.serviceId + '/password');
            }
            catch {
                this.expired = true;
            }
            return { serviceId: context.serviceId, ready: false, observations: ['fixture.late'] };
        }
        if (this.count === 5) {
            const end = Date.now() + 500;
            while (Date.now() < end) { }
            return { serviceId: context.serviceId, ready: true, observations: ['fixture.late-blocking'] };
        }
        let denied = false;
        try {
            await context.credential('secret://foreign/password');
        }
        catch {
            denied = true;
        }
        const observation = context.observation, metadata = !!observation && observation.identity.serviceId === context.serviceId && observation.identity.installationId === context.expected.installationId && observation.identity.compositionGeneration === context.expected.compositionGeneration && observation.identity.serviceGeneration === context.expected.serviceGeneration && observation.identity.assetDigest === context.expected.assetDigest && Object.isFrozen(observation) && Object.isFrozen(observation.identity) && Object.isFrozen(observation.dependencies);
        const own = await context.credential('secret://' + context.serviceId + '/password'), ready = metadata && this.expired && denied && own.length === 64 && Object.isFrozen(context) && Object.isFrozen(context.expected) && Object.isFrozen(context.credentialReferences) && Reflect.get(context, 'credentials') === undefined;
        return { serviceId: context.serviceId, ready, observations: ready ? ['fixture.capabilities-qualified', 'fixture.observation-qualified'] : ['fixture.capabilities-invalid'] };
    }
    private static delay(done: (value: void) => void): void { setTimeout(done, 400); }
}

export class AuthorityContainerFixture extends RuntimeContainerFixture {
    static override readonly declaration = ProviderV4Schemas.declaration.parse({ ...RuntimeContainerFixture.declaration, id: 'fixture.authority-container' });
    static override readonly container = PluginManagementSchemas.container.parse({ ...RuntimeContainerFixture.container, resources: { ...RuntimeContainerFixture.container.resources, authorities: [{ id: 'public-ca', volume: 'data', path: 'root.crt' }] } });
}
/** Exact selectable replacement fixture: same owned state, observable new process configuration. */
export class RestartAuthorityFixture extends AuthorityContainerFixture {
    static override readonly declaration = ProviderV4Schemas.declaration.parse({...AuthorityContainerFixture.declaration,id:'fixture.restart-authority'});
    static override readonly container = PluginManagementSchemas.container.parse({...AuthorityContainerFixture.container,definition:{...AuthorityContainerFixture.container.definition,environment:{...AuthorityContainerFixture.container.definition.environment,FIXTURE_REVISION:'replacement'}}});
}
export class AuthorityConsumerFixture extends AuthorityContainerFixture {
    static override readonly declaration = ProviderV4Schemas.declaration.parse({ ...AuthorityContainerFixture.declaration, id: 'fixture.authority-consumer' });
    static override readonly container = PluginManagementSchemas.container.parse({ ...AuthorityContainerFixture.container, dependencies: [{ port: 'primary', contractId: 'fixture.echo', contractVersion: '1.0.0' }], resources: { ...AuthorityContainerFixture.container.resources, grants: [{ dependencyPort: 'primary', slot: 'public-ca' }] } });
}
export class AuthorityProbeFixture extends ProbeFixture {
    static override readonly declaration = ProviderV4Schemas.declaration.parse({ ...ProbeFixture.declaration, id: 'fixture.authority-probe' });
    override async observe(context: ProbeContext): Promise<ServiceReadiness> {
        const own = 'secret://' + context.serviceId + '/public-ca';
        if (!context.authorityIds.includes(own) || context.credentialReferences.includes(own) || !Object.isFrozen(context.authorityIds)) throw new Error('Authority boundary missing');
        for (const reference of context.authorityIds) if (!new X509Certificate(await context.authority(reference)).ca) throw new Error('Not a public CA');
        let credentialDenied = false, foreignDenied = false;
        try { await context.credential(own); } catch { credentialDenied = true; }
        try { await context.authority('secret://' + (context.serviceId === 'instance-4' ? 'instance-3' : 'instance-4') + '/public-ca'); } catch { foreignDenied = true; }
        if (!credentialDenied || !foreignDenied) throw new Error('Authority grant escaped');
        return super.observe(context);
    }
}

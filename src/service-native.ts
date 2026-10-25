import { join } from 'node:path';
import { CanonicalJson, PlatformSchemas, ProviderV4Schemas, ServiceSchemas, ServiceTokens, type ServicePlan, type ServiceInstance, type ServiceEngine, type ServiceIdentity, type ServiceReadiness, type ProbeContext, type ServiceProbe } from '@treeseed-cordis/sdk';
import { Context, CordisComposition, CordisServiceLocator, InstalledProviderLoader, type CompositionHandle, type ProviderRegistration, type ProviderLease } from '@treeseed-cordis/sdk/runtime';
import { ServicePlanStore } from './service-plan.js';
import { ServiceContainerEngine, ServiceExecution, ScopedServiceEngine, ServiceRuntimeInspection } from './service-engine.js';
import { ServiceCredentials } from './service-credentials.js';
import { ServiceProviderStager, type PreparedServiceProvider } from './service-staging.js';
import { InstallationWriter } from './installed.js';
import { StrictJson, PlanningFailure as Check } from './filesystem.js';
export interface PreparedServiceScope {
    container: PreparedServiceProvider;
    probe: PreparedServiceProvider;
}
class ProbeAccess implements ProbeContext {
    #credentials: ServiceCredentials;
    readonly expected: ProbeContext['expected'];
    readonly credentialReferences: readonly string[];
    readonly authorityIds: readonly string[] = [];
    constructor(readonly serviceId: string, readonly endpoint: string, readonly deadline: number, readonly signal: AbortSignal, plan: ServicePlan, credentials: ServiceCredentials) { this.#credentials = credentials; const service = NativeServices.service(plan, serviceId), change = plan.changes.find(NativeServices.named.bind(null, serviceId)); Check.require(change, 'SERVICE_SCOPE'); this.expected = Object.freeze({ installationId: plan.configuration.installationId, compositionGeneration: plan.compositionGeneration, serviceGeneration: change.serviceGeneration, assetDigest: plan.composition.assetDigest }); this.credentialReferences = Object.freeze([...service.readiness.credentialReferences]); Object.freeze(this.authorityIds); Object.freeze(this); }
    private accepted(): void { Check.require(!this.signal.aborted && Date.now() < this.deadline, 'PROBE_DEADLINE'); }
    async credential(reference: string): Promise<Uint8Array> { this.accepted(); Check.require(this.credentialReferences.includes(reference), 'UNGRANTED_PROBE_REFERENCE'); const bytes = this.#credentials.probe(this.serviceId, reference); this.accepted(); return bytes; }
    async authority(_id: string): Promise<Uint8Array> { this.accepted(); return Check.block('PROBE_AUTHORITY_NOT_PREPARED'); }
}
class NativeServices {
    static named(id: string, value: {
        serviceId: string;
    }): boolean { return id === value.serviceId; }
    static service(plan: ServicePlan, id: string): ServiceInstance { const service = plan.composition.services.find(this.named.bind(null, id)); Check.require(service, 'SERVICE_SCOPE'); return service; }
    static authority(plan: ServicePlan, writer: InstallationWriter): void {
        const store = new ServicePlanStore(plan.configuration.installationDirectory);
        writer.assert(store.path);
        Check.require(CanonicalJson.stringify(store.read(plan.id, plan.digest)) === CanonicalJson.stringify(plan), 'PLAN_BINDING');
        let accepted = false;
        for (const event of store.records())
            if (event.planId === plan.id && event.digest === plan.digest && event.phase === 'activate')
                accepted = true;
        Check.require(accepted, 'ACCEPTED_ACTIVATION_REQUIRED');
    }
    static manifest(plan: ServicePlan, id: string, kind: 'container' | 'probe', prepared: PreparedServiceProvider): void { const service = this.service(plan, id), reference = kind === 'container' ? service.provider : service.readiness.provider, configuration = kind === 'container' ? service.configuration : service.readiness.configuration, scopeId = 'installation:' + plan.configuration.installationId + ':service:' + id; Check.require(prepared.scopeId === scopeId && /^[a-f0-9]{64}$/.test(prepared.digest) && prepared.file === join(plan.configuration.installationDirectory, '.cordis/artifacts/providers', prepared.digest, 'manifest.json'), 'PROVIDER_SCOPE'); const bytes = InstalledProviderLoader.read(prepared.file); Check.require(InstalledProviderLoader.sha(bytes) === prepared.digest, 'PROVIDER_INTEGRITY'); const manifest = ProviderV4Schemas.manifest.parse(StrictJson.parse(bytes)); Check.require(manifest.scopeId === scopeId && manifest.target === 'deployment' && manifest.providerId === reference.providerId && manifest.entry === reference.entry && manifest.classExport === reference.classExport && manifest.package.name === reference.package.name && manifest.package.version === reference.package.version && CanonicalJson.stringify(manifest.configuration) === CanonicalJson.stringify(configuration), 'PROVIDER_BINDING'); }
    static unready(id: string, code: string): ServiceReadiness { return { serviceId: id, ready: false, observations: [code] }; }
}
/** Keeps a native lease until the actual accepted promise settles, including after timeout. */
class ProbeInvocation {
    private timer: ReturnType<typeof setTimeout> | undefined;
    private accept: ((value: ServiceReadiness) => void) | undefined;
    private returned = false;
    private finished = false;
    constructor(private readonly owner: NativeObservation, private readonly lease: ProviderLease<ServiceProbe>, private readonly context: ProbeAccess) { }
    run(): Promise<ServiceReadiness> { return new Promise(this.start.bind(this)); }
    private start(accept: (value: ServiceReadiness) => void): void {
        this.accept = accept;
        this.timer = setTimeout(this.timeout.bind(this), Math.max(1, this.context.deadline - Date.now()));
        try {
            void this.lease.value.observe(this.context).then(this.succeeded.bind(this), this.failed.bind(this));
        }
        catch {
            void this.failed();
        }
    }
    private timeout(): void {
        if (this.returned)
            return;
        this.owner.abort(this.context);
        this.returned = true;
        this.accept!(NativeServices.unready(this.context.serviceId, 'probe.deadline'));
    }
    private async succeeded(value: ServiceReadiness): Promise<void> {
        let result: ServiceReadiness;
        try {
            result = Date.now() >= this.context.deadline ? NativeServices.unready(this.context.serviceId, 'probe.deadline') : this.owner.validate(value, this.lease.generation);
        }
        catch {
            result = NativeServices.unready(this.context.serviceId, 'probe.invalid-result');
        }
        await this.complete(result);
    }
    private failed(): Promise<void> { return this.complete(NativeServices.unready(this.context.serviceId, 'probe.unavailable')); }
    private async complete(value: ServiceReadiness): Promise<void> {
        if (this.finished)
            return;
        this.finished = true;
        try {
            await this.lease.release();
        }
        catch {
            value = NativeServices.unready(this.context.serviceId, 'probe.cleanup-failed');
        }
        finally {
            clearTimeout(this.timer);
            this.owner.abort(this.context);
            this.owner.settled(this);
            if (!this.returned) {
                this.returned = true;
                this.accept!(value.ready && Date.now() >= this.context.deadline ? NativeServices.unready(this.context.serviceId, 'probe.deadline') : value);
            }
        }
    }
}
class NativeObservation {
    private current: ProbeInvocation | null = null;
    private readonly controllers = new WeakMap<ProbeContext, AbortController>();
    private readonly credentials: ServiceCredentials;
    constructor(private readonly plan: ServicePlan, private readonly id: string, private readonly context: Context) { this.credentials = new ServiceCredentials(plan); }
    abort(context: ProbeContext): void { this.controllers.get(context)?.abort(); }
    settled(invocation: ProbeInvocation): void {
        if (this.current === invocation)
            this.current = null;
    }
    async ready(): Promise<ServiceReadiness> {
        if (this.current)
            return NativeServices.unready(this.id, 'probe.pending');
        const service = NativeServices.service(this.plan, this.id), target = await new ServiceRuntimeInspection(this.plan).service(service.readiness.endpoint.serviceId, service.readiness.endpoint.portId, service.readiness.scheme);
        if (!target.running)
            return NativeServices.unready(this.id, 'service.stopped');
        const controller = new AbortController(), access = new ProbeAccess(this.id, target.endpoint, Date.now() + service.readiness.deadlineMs, controller.signal, this.plan, this.credentials);
        this.controllers.set(access, controller);
        const lease = await CordisServiceLocator.from(this.context).acquire(ServiceTokens.probe()), invocation = new ProbeInvocation(this, lease, access);
        if (this.current) {
            await lease.release();
            return NativeServices.unready(this.id, 'probe.pending');
        }
        this.current = invocation;
        return invocation.run();
    }
    validate(value: ServiceReadiness, runtimeGeneration: string): ServiceReadiness {
        Check.require(value && value.serviceId === this.id && typeof value.ready === 'boolean' && Array.isArray(value.observations) && value.observations.length <= 64, 'INVALID_PROBE_RESULT');
        const observations: string[] = [];
        for (const text of value.observations) {
            Check.require(typeof text === 'string' && /^[a-z][a-z0-9.-]{0,127}$/.test(text), 'INVALID_PROBE_RESULT');
            observations.push(text);
        }
        if (!value.ready)
            return { serviceId: this.id, ready: false, observations };
        const acknowledgements = [];
        for (const input of value.acknowledgements ?? []) {
            const ack = ServiceSchemas.acknowledgement.parse(input);
            Check.require(ack.ready && ack.generation === this.plan.compositionGeneration, 'INVALID_TARGET_ACKNOWLEDGEMENT');
            acknowledgements.push(ack);
        }
        Check.require(acknowledgements.length < 512, 'INVALID_PROBE_RESULT');
        acknowledgements.push(ServiceSchemas.acknowledgement.parse({ target: 'deployment', scopeId: 'installation:' + this.plan.configuration.installationId + ':service:' + this.id, generation: this.plan.compositionGeneration, runtimeGeneration, observationDigest: CanonicalJson.digest({ serviceId: this.id, readiness: NativeServices.service(this.plan, this.id).readiness, observations }), ready: true }));
        return { serviceId: this.id, ready: true, observations, acknowledgements };
    }
}
class NativeEngine implements ServiceEngine {
    #scoped: ScopedServiceEngine;
    #observation: NativeObservation;
    constructor(scoped: ScopedServiceEngine, observation: NativeObservation) { this.#scoped = scoped; this.#observation = observation; }
    start(id: string, definition: ServiceInstance['definition']): Promise<void> { return this.#scoped.start(id, definition); }
    identity(id: string): ServiceIdentity { return this.#scoped.identity(id); }
    ready(id: string): Promise<ServiceReadiness> { this.#scoped.identity(id); return this.#observation.ready(); }
}
/** Actual native root per accepted service. Holds framework handles, never provider instances. */
export class ServiceNativeScope {
    private closed = false;
    private fenced = false;
    private constructor(private readonly handle: CompositionHandle, private readonly consumer: Context, private readonly serviceId: string) { }
    get generation(): string { return this.handle.generation; }
    static async prepare(plan: ServicePlan, id: string, writer: InstallationWriter): Promise<PreparedServiceScope> { const stager = new ServiceProviderStager(plan); return { container: await stager.stage(id, 'container', writer), probe: await stager.stage(id, 'probe', writer) }; }
    static async open(input: ServicePlan, id: string, prepared: PreparedServiceScope, writer: InstallationWriter): Promise<ServiceNativeScope> {
        const plan = ServiceSchemas.plan.parse(input);
        NativeServices.authority(plan, writer);
        NativeServices.manifest(plan, id, 'container', prepared.container);
        NativeServices.manifest(plan, id, 'probe', prepared.probe);
        const scopeId = prepared.container.scopeId, execution = new ServiceExecution(plan, id), physical = new ServiceContainerEngine(plan, writer), scoped = new ScopedServiceEngine(id, physical), artifact = { kind: 'bundled' as const, identity: 'deployment-native-service-scope.1:' + plan.composition.worker.sha256 };
        class ContextPlugin {
            static readonly provide = [ServiceTokens.context.id];
            static readonly inject: string[] = [];
            static readonly Config = PlatformSchemas.empty;
            constructor(context: Context) { context.provide(ServiceTokens.context.id, execution); }
        }
        class EnginePlugin {
            static readonly provide = [ServiceTokens.engine.id];
            static readonly inject = ['cordis.composition', ServiceTokens.probe().id];
            static readonly Config = PlatformSchemas.empty;
            constructor(context: Context) { context.provide(ServiceTokens.engine.id, new NativeEngine(scoped, new NativeObservation(plan, id, context))); }
        }
        const registrations: ProviderRegistration[] = [await InstalledProviderLoader.load(prepared.container.file, prepared.container.digest, ServiceTokens.container(), 'deployment', scopeId), await InstalledProviderLoader.load(prepared.probe.file, prepared.probe.digest, ServiceTokens.probe(), 'deployment', scopeId)];
        for (const [token, plugin] of [[ServiceTokens.context, ContextPlugin], [ServiceTokens.engine, EnginePlugin]] as const)
            registrations.push({ token, plugin, artifact, configuration: {}, declaration: ProviderV4Schemas.declaration.parse({ id: 'deployment.native.' + token.id, pluginId: 'deployment', capability: token.id, contractVersion: ProviderV4Schemas.version, target: 'deployment', provide: plugin.provide, inject: plugin.inject }) });
        const selections = [];
        for (const registration of registrations)
            selections.push({ scopeId, capability: registration.token.id, providerId: ProviderV4Schemas.declaration.parse(registration.declaration).id });
        NativeServices.authority(plan, writer);
        const handle = await CordisComposition.start({ registrations, selections }, { scopeId, target: 'deployment', principalId: 'uid:' + process.getuid!(), resourceScope: plan.configuration.installationDirectory });
        const receiver: {
            context?: Context;
        } = {};
        class Consumer {
            static readonly inject = ['cordis.composition', ServiceTokens.container().id, ServiceTokens.engine.id];
            constructor(context: Context) { receiver.context = context; }
        }
        try {
            await handle.mount(Consumer, undefined);
            Check.require(receiver.context, 'NATIVE_SERVICE_SCOPE');
            return new ServiceNativeScope(handle, receiver.context, id);
        }
        catch (error) {
            await handle.dispose();
            throw error;
        }
    }
    acquire(): Promise<ProviderLease<import('@treeseed-cordis/sdk').ContainerService>> { Check.require(!this.closed && !this.fenced, 'SERVICE_SCOPE_CLOSED'); return CordisServiceLocator.from(this.consumer).acquire(ServiceTokens.container()); }
    async ready(): Promise<ServiceReadiness> {
        const lease = await this.acquire();
        try {
            const identity = lease.value.identity();
            Check.require(identity.serviceId === this.serviceId, 'SERVICE_SCOPE');
            const engine = await CordisServiceLocator.from(this.consumer).acquire(ServiceTokens.engine);
            try {
                return await engine.value.ready(this.serviceId);
            }
            finally {
                await engine.release();
            }
        }
        finally {
            await lease.release();
        }
    }
    async close(timeoutMs = 10000): Promise<void> {
        if (this.closed)
            return;
        if (!await this.handle.drain(timeoutMs)) {
            this.fenced = true;
            this.handle.fence();
            Check.block('SERVICE_SCOPE_DRAIN_PENDING');
        }
        await this.handle.dispose();
        this.closed = true;
    }
}

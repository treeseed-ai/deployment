import { ServiceObservations } from './service-observation.js';
import { CanonicalJson, CapabilityToken, PlatformSchemas, ProviderV4Schemas, ServiceSchemas, type ServicePlan, type ServiceApplicationRecord, type ServiceWorkerRequest, type ServiceStatus, type ServiceObservationContext, type ServiceSnapshot, type ServiceResourceReceipt, type ServiceReadiness } from '@treeseed-cordis/sdk';
import { Context, CordisComposition, CordisServiceLocator, type CompositionHandle, type ProviderRegistration } from '@treeseed-cordis/sdk/runtime';
import { DockerCommands } from './docker-commands.js';
import { ServicePlanStore, ServicePlanIdentity, ServicePlanningHost, ServiceTransitions } from './service-plan.js';
import { ServiceNativeScope, type PreparedServiceScope } from './service-native.js';
import { ServiceImages, LocalDockerCommands } from './service-images.js';
import { HostSystem, TcpTableProbe } from './host-system.js';
import { ServiceCredentials } from './service-credentials.js';
import { RuntimeResources, ServiceRuntimeInspection } from './service-engine.js';
import { ServiceArtifactResolver } from './service-artifacts.js';
import { InstallationWriter } from './installed.js';
import { InstallationAuthority, InstallationAuthorityPlugin, InstallationAuthorityToken } from './service-authority.js';
import { StrictJson, PlanningFailure as Check } from './filesystem.js';
export interface ServiceApplicationHost {
    plan(configuration:ServicePlan['configuration']):Promise<ServicePlan>;
    submit(request: Extract<ServiceWorkerRequest, {
        operation: 'submit';
    }>): Promise<{
        id: string;
        accepted: true;
    }>;
    status(): Promise<ServiceStatus>;
    observationContext(serviceId: string): Promise<ServiceObservationContext>;
    application(id: string): Promise<ServiceApplicationRecord>;
}
class ApplicationAdapter {
    parse(value: unknown): ServiceApplicationHost {
        Check.require(value && typeof value === 'object', 'INVALID_APPLICATION_HOST');
        for (const method of ['submit', 'status', 'application', 'observationContext','plan'])
            Check.require(typeof Reflect.get(value, method) === 'function', 'INVALID_APPLICATION_HOST');
        return value as ServiceApplicationHost;
    }
}
export class ServiceApplicationToken {
    static readonly host = new CapabilityToken<ServiceApplicationHost>('deployment.applications', ProviderV4Schemas.version, new ApplicationAdapter());
}
/** One immutable observation per target/scope, including independently routed attestations. */
export class ServiceAcknowledgements {
    private readonly entries = new Map<string, ServiceSnapshot['acknowledgements'][number]>();
    constructor(private readonly generation: string) {}
    add(input: ServiceSnapshot['acknowledgements'][number]): void {
        const value = ServiceSchemas.acknowledgement.parse(input), key = value.target + ':' + value.scopeId, prior = this.entries.get(key);
        Check.require(value.ready && value.generation === this.generation && (!prior || CanonicalJson.stringify(prior) === CanonicalJson.stringify(value)), 'INVALID_TARGET_ACKNOWLEDGEMENT');
        this.entries.set(key, value);
    }
    values(): ServiceSnapshot['acknowledgements'] { return [...this.entries.values()].sort(ServiceAcknowledgements.order); }
    private static order(a: {target: string;scopeId: string}, b: {target: string;scopeId: string}): number { const left=a.target+':'+a.scopeId,right=b.target+':'+b.scopeId; return left<right?-1:left>right?1:0; }
}
/** Transaction state and native framework handles only; the existing journal remains authoritative. */
class ServiceApplications implements ServiceApplicationHost {
    private readonly store: ServicePlanStore;
    private readonly writer: InstallationWriter;
    private readonly scopes = new Map<string, ServiceNativeScope>();
    private job: Promise<void> | null = null;
    private closed = false;
    private faulted = false;
    private planning = false;
    constructor(private acceptedPlan: ServicePlan, authority: InstallationAuthority, private readonly locator: CordisServiceLocator) { Check.require(CanonicalJson.stringify(authority.plan) === CanonicalJson.stringify(acceptedPlan), 'PLAN_BINDING'); this.store = authority.store; this.writer = authority.writer; }
    async submit(request: Extract<ServiceWorkerRequest, {
        operation: 'submit';
    }>): Promise<{
        id: string;
        accepted: true;
    }> {
        Check.require(!this.closed,'HOST_RECOVERY_REQUIRED');this.writer.assert(this.store.path);
        for(const record of this.store.records())if(record.idempotencyKey===request.idempotencyKey){const repeated=this.store.accept(request,this.writer);return {id:repeated.record.id,accepted:true};}
        Check.require(!this.faulted,'HOST_RECOVERY_REQUIRED');Check.require(!this.planning&&this.job===null,'APPLICATION_BUSY');
        const candidate=this.store.read(request.planId,request.digest),current=this.store.current();ServiceTransitions.activation(candidate,request.restartServices,this.acceptedPlan);
        if(current)Check.require(candidate.expectedComposition===current.compositionGeneration&&candidate.expectedResourceSet===CanonicalJson.digest(current.resources),'STALE_GENERATION');else Check.require(candidate.id===this.acceptedPlan.id&&candidate.digest===this.acceptedPlan.digest,'PLAN_BINDING');
        const accepted=this.store.accept(request,this.writer);
        if(accepted.fresh)this.job=this.execute(accepted.record,candidate).catch(this.backgroundFailed.bind(this)).finally(this.finished.bind(this));
        return { id: accepted.record.id, accepted: true };
    }
    async plan(input:ServicePlan['configuration']):Promise<ServicePlan>{
        Check.require(!this.closed&&!this.faulted,'HOST_RECOVERY_REQUIRED');Check.require(!this.planning&&this.job===null,'APPLICATION_BUSY');this.writer.assert(this.store.path);input=ServiceSchemas.configuration.parse(input);Check.require(input.installationId===this.acceptedPlan.configuration.installationId&&input.installationDirectory===this.store.path&&input.engineContext===this.acceptedPlan.expectedEngine.context&&new URL(input.origin).origin===this.acceptedPlan.configuration.origin,'TRANSITION_SCOPE');
        Check.require(input.runtimeState===this.acceptedPlan.configuration.runtimeState,'RUNTIME_STATE_TRANSITION_UNSUPPORTED');
        this.planning=true;try{const current=this.store.current();Check.require(current&&current.compositionGeneration===this.acceptedPlan.compositionGeneration,'ACTIVE_COMPOSITION_REQUIRED');Check.require((await this.status()).ready,'SERVICE_NOT_READY');return await new ServicePlanningHost(new DockerCommands(),new HostSystem(),{previous:this.acceptedPlan,writer:this.writer}).plan(input);}finally{this.planning=false;}
    }
    private finished(): void { this.job = null; }
    private backgroundFailed(_error: unknown): void { this.faulted = true; }
    async application(id: string): Promise<ServiceApplicationRecord> {
        id = ServiceSchemas.applicationRecord.shape.id.parse(id);
        for (const record of this.store.records())
            if (record.id === id)
                return record;
        return Check.block('APPLICATION_NOT_FOUND');
    }
    private event(previous: ServiceApplicationRecord, phase: ServiceApplicationRecord['phase']): ServiceApplicationRecord { const record = { ...previous, sequence: previous.sequence + 1, phase, result: null }; this.store.append(record, this.writer); return record; }
    private async validate(candidate:ServicePlan,restartServices?:string[]): Promise<void> { const system = new HostSystem(), host = system.host(); Check.require(host.os === 'linux' && host.architecture === 'x64' && host.distribution === 'ubuntu' && host.release === '26.04', 'UNSUPPORTED_HOST'); Check.require(system.storage(this.store.path).code === 'OK', 'STORAGE_PERMISSION'); const commands = new LocalDockerCommands(); await commands.verify(candidate.expectedEngine); const info = StrictJson.object(StrictJson.parse(Buffer.from(await commands.run(candidate.expectedEngine, ['info', '--format', '{{json .}}'])))); Check.require(Number(info.NCPU) >= 2 && Number(info.MemTotal) >= 2 * 1024 ** 3, 'ENGINE_CAPACITY'); const current=this.store.current();if(current){Check.require(current.compositionGeneration===this.acceptedPlan.compositionGeneration&&candidate.expectedComposition===current.compositionGeneration&&candidate.expectedResourceSet===CanonicalJson.digest(current.resources),'STALE_GENERATION');Check.require(CanonicalJson.stringify(ServiceTransitions.plan(this.acceptedPlan,candidate))===CanonicalJson.stringify(candidate.changes)&&CanonicalJson.stringify(candidate.retainedResources)===CanonicalJson.stringify(ServiceTransitions.retained(this.acceptedPlan,candidate,current.resources)),'PLAN_BINDING');ServiceTransitions.activation(candidate,restartServices,this.acceptedPlan);await new ServiceRuntimeInspection(this.acceptedPlan).audit();}else{const origin=new URL(candidate.configuration.origin);Check.require(await new TcpTableProbe().available(Number(origin.port||(origin.protocol==='https:'?443:80))),'PORT_UNAVAILABLE');} const resolved = await new ServiceArtifactResolver().resolve(candidate.configuration); Check.require(resolved.releaseDigest === candidate.releaseDigest && resolved.lockDigest === candidate.lockDigest && resolved.recipeDigest === candidate.recipeDigest && CanonicalJson.stringify(resolved.artifacts) === CanonicalJson.stringify(candidate.artifacts) && CanonicalJson.stringify(ServicePlanIdentity.graph(resolved.inventory.composition)) === CanonicalJson.stringify(candidate.composition), 'PLAN_BINDING'); Check.require(CanonicalJson.stringify(resolved.runtimeBindings) === CanonicalJson.stringify(candidate.runtimeBindings ?? {}), 'RUNTIME_BINDING_CHANGED'); await new ServiceRuntimeInspection(this.acceptedPlan).audit(); }
    private order(): string[] {
        const result: string[] = [], waiting = new Set<string>();
        for (const service of this.acceptedPlan.composition.services)
            waiting.add(service.serviceId);
        while (waiting.size) {
            let progress = false;
            for (const id of [...waiting]) {
                const service = this.acceptedPlan.composition.services.find(ServiceApplications.named.bind(null, id))!;
                let ready = true;
                for (const dependency of service.dependencies)
                    for (const source of this.acceptedPlan.composition.services)
                        for (const binding of source.bindings)
                            if (binding.bindingId === dependency.bindingId && !result.includes(source.serviceId))
                                ready = false;
                const target = service.readiness.endpoint.serviceId;
                if (target !== id && !result.includes(target))
                    ready = false;
                if (!ready)
                    continue;
                result.push(id);
                waiting.delete(id);
                progress = true;
            }
            Check.require(progress, 'SERVICE_DEPENDENCY_CYCLE');
        }
        return result;
    }
    private static named(id: string, value: {
        serviceId: string;
    }): boolean { return id === value.serviceId; }
    private async observe(id: string): Promise<ServiceReadiness> {
        const service = this.acceptedPlan.composition.services.find(ServiceApplications.named.bind(null, id))!, scope = this.scopes.get(id);
        Check.require(scope, 'MISSING_NATIVE_SCOPE');
        const deadline = Date.now() + service.readiness.deadlineMs;
        let result = await scope.ready();
        while (!result.ready && Date.now() < deadline) {
            await new Promise(ServiceApplications.delay);
            result = await scope.ready();
        }
        Check.require(result.ready && Date.now() <= deadline, 'SERVICE_NOT_READY');
        return result;
    }
    private static delay(done: (value: void) => void): void { setTimeout(done, 50); }
    private resources(plan:ServicePlan=this.acceptedPlan): ServiceResourceReceipt[] {
        const selected = new Map<string, ServiceResourceReceipt>();
        for (const resource of RuntimeResources.selected(this.store,plan))
            if (resource.references.includes(plan.compositionGeneration)) {
                const prior = selected.get(resource.resourceId);
                if (!prior || prior.references.length < resource.references.length)
                    selected.set(resource.resourceId, resource);
            }
        const result = [...selected.values()];
        result.sort(ServiceApplications.resourceOrder);
        return result;
    }
    private static resourceOrder(a: {
        resourceId: string;
    }, b: {
        resourceId: string;
    }): number { return a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0; }
    private async snapshot(): Promise<ServiceSnapshot> {
        const evidence = new ServiceAcknowledgements(this.acceptedPlan.compositionGeneration);
        for (const service of this.acceptedPlan.composition.services) {
            const result = await this.observe(service.serviceId);
            Check.require(result.serviceId === service.serviceId && result.acknowledgements?.length, 'MISSING_TARGET_ACKNOWLEDGEMENT');
            for (const ack of result.acknowledgements) evidence.add(ack);
        }
        const acknowledgements = evidence.values();
        await new ServiceRuntimeInspection(this.acceptedPlan).audit();
        const resources: ServiceSnapshot['resources'] = [];
        for (const receipt of this.resources())
            resources.push({ resourceId: receipt.resourceId, kind: receipt.kind, serviceId: receipt.serviceId, creatingGeneration: receipt.creatingGeneration, receiptDigest: CanonicalJson.digest(receipt) });
        return ServiceSchemas.snapshot.parse({ formatVersion: 3, installationId: this.acceptedPlan.configuration.installationId, installationDirectory: this.store.path, compositionGeneration: this.acceptedPlan.compositionGeneration, resources, acknowledgements });
    }
    private async execute(initial: ServiceApplicationRecord,candidate:ServicePlan): Promise<void> {
        const lease = await this.locator.acquire(InstallationAuthorityToken.instance);
        try {
            await this.apply(initial,candidate);
        }
        finally {
            await lease.release();
        }
    }
    private async apply(initial: ServiceApplicationRecord,candidate:ServicePlan): Promise<void> {
        let record = initial;
        try {
            await this.validate(candidate,initial.restartServices);
            record = this.event(record, 'stage');
            this.acceptedPlan=candidate;for(const scope of this.scopes.values())await scope.close();this.scopes.clear();
            const prepared = new Map<string, PreparedServiceScope>();
            for (const service of this.acceptedPlan.composition.services)
                prepared.set(service.serviceId, await ServiceNativeScope.prepare(this.acceptedPlan, service.serviceId, this.writer));
            await new ServiceImages(this.acceptedPlan).stage(this.writer);
            record = this.event(record, 'prepare');
            await new ServiceCredentials(this.acceptedPlan).prepare(this.writer);
            if (this.acceptedPlan.configuration.runtimeState === 'stopped') {
                record = this.event(record, 'commit');
                this.store.append({ ...record, sequence: record.sequence + 1, phase: 'completed', result: 'stopped' }, this.writer);
                return;
            }
            record = this.event(record, 'activate');
            for (const id of this.order()) {
                const scope = await ServiceNativeScope.open(this.acceptedPlan, id, prepared.get(id)!, this.writer);
                this.scopes.set(id, scope);
                await this.observe(id);
            }
            record = this.event(record, 'readiness');
            const snapshot = await this.snapshot();
            this.store.saveSnapshot(snapshot, this.writer);
            record = this.event(record, 'commit');
            this.store.append({ ...record, sequence: record.sequence + 1, phase: 'completed', result: 'ready', activeComposition: this.acceptedPlan.compositionGeneration, resourceSetDigest: CanonicalJson.digest(snapshot.resources), acknowledgements: snapshot.acknowledgements }, this.writer);
        }
        catch {
            const recovery = record.phase === 'validate' ? null : 'repair-required';
            this.store.append({ ...record, sequence: record.sequence + 1, phase: 'failed', result: 'failed', recovery }, this.writer);
        }
    }
    async observationContext(serviceId:string):Promise<ServiceObservationContext>{this.writer.assert(this.store.path);let accepted=false;for(const record of this.store.records())if(record.planId===this.acceptedPlan.id&&record.digest===this.acceptedPlan.digest&&['stage','prepare','activate','readiness','commit','completed'].includes(record.phase))accepted=true;Check.require(accepted,'SERVICE_NOT_ACCEPTED');return new ServiceObservations(this.acceptedPlan).context(serviceId);}
    private activePlan(generation:string,records:ServiceApplicationRecord[]):ServicePlan{for(const record of records)if(record.phase==='completed'&&record.result==='ready'&&record.activeComposition===generation)return this.store.read(record.planId,record.digest);return Check.block('INVALID_ACTIVE_COMPOSITION');}
    async status(): Promise<ServiceStatus> {
        const records = this.store.records(), last = records.at(-1), current = this.store.current(), services: ServiceStatus['services'] = [], blockers: ServiceStatus['blockers'] = [], freshAcks = new ServiceAcknowledgements(this.acceptedPlan.compositionGeneration);
        let ready = current !== null && current.compositionGeneration===this.acceptedPlan.compositionGeneration&&!last?.recovery&&!this.faulted;
        if (current) {
            try {
                await new ServiceRuntimeInspection(this.acceptedPlan).audit();
            }
            catch {
                ready = false;
                blockers.push({ code: 'RESOURCE_IDENTITY_CHANGED', message: 'An installed resource requires verification.' });
            }
            const activePlan=this.activePlan(current.compositionGeneration,records),resources=this.resources(activePlan);
            for (const service of activePlan.composition.services) {
                let qualified = false, observations: readonly string[] = ['service.unavailable'];
                try {
                    const scope = this.scopes.get(service.serviceId);
                    Check.require(scope, 'MISSING_NATIVE_SCOPE');
                    const result = await scope.ready();
                    qualified = result.ready;
                    observations = result.observations;
                    if (qualified)
                        for (const ack of result.acknowledgements ?? [])
                            freshAcks.add(ack);
                }
                catch { qualified = false; }
                let container: ServiceResourceReceipt | undefined;
                for (const receipt of resources)
                    if (receipt.kind === 'container' && receipt.serviceId === service.serviceId)
                        container = receipt;
                const change = activePlan.changes.find(ServiceApplications.named.bind(null, service.serviceId));
                Check.require(container && change, 'MISSING_RESOURCE');
                services.push({ serviceId: service.serviceId, providerId: service.provider.providerId, serviceGeneration: change.serviceGeneration, resourceId: container.resourceId, ready: qualified, observations: [...observations] });
                if (!qualified)
                    ready = false;
            }
        }
        if (last?.recovery)
            blockers.push({ code: 'APPLICATION_RECOVERY_REQUIRED', message: 'Application effects require explicit repair.' });
        if (this.faulted)
            blockers.push({ code: 'HOST_RECOVERY_REQUIRED', message: 'Host requires explicit repair.' });
        else if (current && !ready)
            blockers.push({ code: 'SERVICE_NOT_READY', message: 'A selected service is not ready.' });
        return ServiceSchemas.status.parse({ formatVersion: 3, installationId: this.acceptedPlan.configuration.installationId, engine: this.acceptedPlan.expectedEngine.context, desiredComposition: last?.desiredComposition ?? null, activeComposition: current?.compositionGeneration ?? null, ready, plugins: [], blockers, applicationId: last?.id ?? null, services, resourceSetDigest: current ? CanonicalJson.digest(current.resources) : null, acknowledgements: ready ? freshAcks.values() : [] });
    }
    async close(): Promise<void> {
        if (this.closed)
            return;
        this.closed = true;
        await this.job;
        for (const scope of this.scopes.values())
            await scope.close();
        this.scopes.clear();
    }
}
export class ServiceApplicationPlugin {
    static readonly provide = [ServiceApplicationToken.host.id];
    static readonly inject = ['cordis.composition', InstallationAuthorityToken.instance.id];
    static readonly Config = ServiceSchemas.plan;
    static readonly declaration = ProviderV4Schemas.declaration.parse({ id: 'deployment.application-host', pluginId: 'deployment', capability: ServiceApplicationToken.host.id, contractVersion: ProviderV4Schemas.version, target: 'deployment', provide: this.provide, inject: this.inject });
    private readonly host: ServiceApplications;
    constructor(context: Context, plan: ServicePlan) { this.host = new ServiceApplications(ServiceSchemas.plan.parse(plan), InstallationAuthorityToken.instance.parse(Reflect.get(context, InstallationAuthorityToken.instance.id)), CordisServiceLocator.from(context)); context.provide(ServiceApplicationToken.host.id, this.host); context.effect(this.effect.bind(this)); }
    private effect(): () => Promise<void> { return this.host.close.bind(this.host); }
}
export class ServiceApplicationRuntime implements ServiceApplicationHost {
    private closed = false;
    private closing = false;
    protected constructor(protected readonly handle: CompositionHandle, protected readonly context: Context) { }
    static async start(input: ServicePlan): Promise<ServiceApplicationRuntime> { const scope = await this.mount(input); return new ServiceApplicationRuntime(scope.handle, scope.context); }
    protected static async mount(input: ServicePlan, extras: readonly ProviderRegistration[] = [], bootstrap?: {
        nonce: string;
    }): Promise<{
        handle: CompositionHandle;
        context: Context;
    }> {
        const plan = ServiceSchemas.plan.parse(input), scopeId = 'installation:' + plan.configuration.installationId + ':host', artifact = { kind: 'bundled' as const, identity: 'deployment-native-host.1:' + plan.composition.worker.sha256 };
        const registrations: ProviderRegistration[] = [{ token: InstallationAuthorityToken.instance, plugin: InstallationAuthorityPlugin, declaration: InstallationAuthorityPlugin.declaration, configuration: { plan, ...(bootstrap ? { bootstrap } : {}) }, artifact }, { token: ServiceApplicationToken.host, plugin: ServiceApplicationPlugin, declaration: ServiceApplicationPlugin.declaration, configuration: plan, artifact }, ...extras], selections = [], inject = ['cordis.composition', ServiceApplicationToken.host.id];
        for (const registration of registrations)
            selections.push({ scopeId, capability: registration.token.id, providerId: ProviderV4Schemas.declaration.parse(registration.declaration).id });
        for (const registration of extras)
            inject.push(registration.token.id);
        const handle = await CordisComposition.start({ registrations, selections }, { scopeId, target: 'deployment', principalId: 'uid:' + process.getuid!(), resourceScope: plan.configuration.installationDirectory }), receiver: {
            context?: Context;
        } = {};
        class Consumer {
            static readonly inject = inject;
            constructor(context: Context) { receiver.context = context; }
        }
        try {
            await handle.mount(Consumer, undefined);
            Check.require(receiver.context, 'NATIVE_HOST_SCOPE');
            return { handle, context: receiver.context };
        }
        catch (error) {
            await handle.dispose();
            throw error;
        }
    }
    describe(): readonly {
        capability: string;
        id: string;
        selected: boolean;
        ready: boolean;
    }[] {
        Check.require(!this.closed && !this.closing, 'HOST_CLOSED');
        const result = [];
        for (const token of [InstallationAuthorityToken.instance, ServiceApplicationToken.host])
            for (const item of this.handle.describe(token))
                result.push({ capability: token.id, id: item.id, selected: item.selected, ready: item.ready });
        return result;
    }
    private acquire() { Check.require(!this.closed && !this.closing, 'HOST_CLOSED'); return CordisServiceLocator.from(this.context).acquire(ServiceApplicationToken.host); }
    async submit(request: Extract<ServiceWorkerRequest, {
        operation: 'submit';
    }>): Promise<{
        id: string;
        accepted: true;
    }> {
        const lease = await this.acquire();
        try {
            return await lease.value.submit(request);
        }
        finally {
            await lease.release();
        }
    }
    async plan(configuration:ServicePlan['configuration']):Promise<ServicePlan>{const lease=await this.acquire();try{return await lease.value.plan(configuration);}finally{await lease.release();}}
    async observationContext(serviceId: string): Promise<ServiceObservationContext> { const lease = await this.acquire(); try { return await lease.value.observationContext(serviceId); } finally { await lease.release(); } }
    async status(): Promise<ServiceStatus> {
        const lease = await this.acquire();
        try {
            return await lease.value.status();
        }
        finally {
            await lease.release();
        }
    }
    async application(id: string): Promise<ServiceApplicationRecord> {
        const lease = await this.acquire();
        try {
            return await lease.value.application(id);
        }
        finally {
            await lease.release();
        }
    }
    async close(timeoutMs = 10000): Promise<void> {
        if (this.closed)
            return;
        this.closing = true;
        if (!await this.handle.drain(timeoutMs)) {
            this.handle.fence();
            Check.block('HOST_DRAIN_PENDING');
        }
        await this.handle.dispose();
        this.closed = true;
    }
}

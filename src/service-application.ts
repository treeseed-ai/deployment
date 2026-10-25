import { CanonicalJson, CapabilityToken, PlatformSchemas, ProviderV4Schemas, ServiceSchemas, type ServicePlan, type ServiceApplicationRecord, type ServiceWorkerRequest, type ServiceStatus, type ServiceSnapshot, type ServiceResourceReceipt, type ServiceReadiness } from '@treeseed-cordis/sdk';
import { Context, CordisComposition, CordisServiceLocator, type CompositionHandle } from '@treeseed-cordis/sdk/runtime';
import { ServicePlanStore, ServicePlanIdentity } from './service-plan.js';
import { ServiceNativeScope, type PreparedServiceScope } from './service-native.js';
import { ServiceImages, LocalDockerCommands } from './service-images.js';
import { HostSystem, TcpTableProbe } from './diagnose.js';
import { ServiceCredentials } from './service-credentials.js';
import { ServiceRuntimeInspection } from './service-engine.js';
import { ServiceArtifactResolver } from './service-artifacts.js';
import { InstallationWriter } from './installed.js';
import { StrictJson, PlanningFailure as Check } from './filesystem.js';
export interface ServiceApplicationHost {
    submit(request: Extract<ServiceWorkerRequest, {
        operation: 'submit';
    }>): Promise<{
        id: string;
        accepted: true;
    }>;
    status(): Promise<ServiceStatus>;
    application(id: string): Promise<ServiceApplicationRecord>;
}
class ApplicationAdapter {
    parse(value: unknown): ServiceApplicationHost {
        Check.require(value && typeof value === 'object', 'INVALID_APPLICATION_HOST');
        for (const method of ['submit', 'status', 'application'])
            Check.require(typeof Reflect.get(value, method) === 'function', 'INVALID_APPLICATION_HOST');
        return value as ServiceApplicationHost;
    }
}
export class ServiceApplicationToken {
    static readonly host = new CapabilityToken<ServiceApplicationHost>('deployment.applications', ProviderV4Schemas.version, new ApplicationAdapter());
}
/** Transaction state and native framework handles only; the existing journal remains authoritative. */
class ServiceApplications implements ServiceApplicationHost {
    private readonly store: ServicePlanStore;
    private readonly writer: InstallationWriter;
    private readonly scopes = new Map<string, ServiceNativeScope>();
    private job: Promise<void> | null = null;
    private closed = false;
    private faulted = false;
    constructor(private readonly plan: ServicePlan) { this.store = new ServicePlanStore(plan.configuration.installationDirectory); Check.require(CanonicalJson.stringify(this.store.read(plan.id, plan.digest)) === CanonicalJson.stringify(plan), 'PLAN_BINDING'); Check.require(this.store.records().length === 0 && this.store.resources().length === 0 && this.store.current() === null, 'WORKER_REPAIR_REQUIRED'); this.writer = this.store.writer(); }
    async submit(request: Extract<ServiceWorkerRequest, {
        operation: 'submit';
    }>): Promise<{
        id: string;
        accepted: true;
    }> {
        Check.require(!this.closed && !this.faulted, 'HOST_RECOVERY_REQUIRED');
        this.writer.assert(this.store.path);
        Check.require(request.planId === this.plan.id && request.digest === this.plan.digest, 'PLAN_BINDING');
        const accepted = this.store.accept(request, this.writer);
        if (accepted.fresh) {
            Check.require(this.job === null, 'APPLICATION_BUSY');
            this.job = this.execute(accepted.record).catch(this.backgroundFailed.bind(this)).finally(this.finished.bind(this));
        }
        return { id: accepted.record.id, accepted: true };
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
    private async validate(): Promise<void> { const system = new HostSystem(), host = system.host(); Check.require(host.os === 'linux' && host.architecture === 'x64' && host.distribution === 'ubuntu' && host.release === '26.04', 'UNSUPPORTED_HOST'); Check.require(system.storage(this.store.path).code === 'OK', 'STORAGE_PERMISSION'); const commands = new LocalDockerCommands(); await commands.verify(this.plan.expectedEngine); const info = StrictJson.object(StrictJson.parse(Buffer.from(await commands.run(this.plan.expectedEngine, ['info', '--format', '{{json .}}'])))); Check.require(Number(info.NCPU) >= 2 && Number(info.MemTotal) >= 2 * 1024 ** 3, 'ENGINE_CAPACITY'); const origin = new URL(this.plan.configuration.origin); Check.require(await new TcpTableProbe().available(Number(origin.port || (origin.protocol === 'https:' ? 443 : 80))), 'PORT_UNAVAILABLE'); const resolved = await new ServiceArtifactResolver().resolve(this.plan.configuration); Check.require(resolved.releaseDigest === this.plan.releaseDigest && resolved.lockDigest === this.plan.lockDigest && resolved.recipeDigest === this.plan.recipeDigest && CanonicalJson.stringify(resolved.artifacts) === CanonicalJson.stringify(this.plan.artifacts) && CanonicalJson.stringify(ServicePlanIdentity.graph(resolved.inventory.composition)) === CanonicalJson.stringify(this.plan.composition), 'PLAN_BINDING'); await new ServiceRuntimeInspection(this.plan).audit(); }
    private order(): string[] {
        const result: string[] = [], waiting = new Set<string>();
        for (const service of this.plan.composition.services)
            waiting.add(service.serviceId);
        while (waiting.size) {
            let progress = false;
            for (const id of [...waiting]) {
                const service = this.plan.composition.services.find(ServiceApplications.named.bind(null, id))!;
                let ready = true;
                for (const dependency of service.dependencies)
                    for (const source of this.plan.composition.services)
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
        const service = this.plan.composition.services.find(ServiceApplications.named.bind(null, id))!, scope = this.scopes.get(id);
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
    private resources(): ServiceResourceReceipt[] {
        const selected = new Map<string, ServiceResourceReceipt>();
        for (const resource of this.store.resources())
            if (resource.references.includes(this.plan.compositionGeneration)) {
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
    private static ackOrder(a: {
        target: string;
        scopeId: string;
    }, b: {
        target: string;
        scopeId: string;
    }): number { const left = a.target + ':' + a.scopeId, right = b.target + ':' + b.scopeId; return left < right ? -1 : left > right ? 1 : 0; }
    private async snapshot(): Promise<ServiceSnapshot> {
        const acknowledgements: ServiceSnapshot['acknowledgements'] = [], ids = new Set<string>();
        for (const service of this.plan.composition.services) {
            const result = await this.observe(service.serviceId);
            Check.require(result.serviceId === service.serviceId && result.acknowledgements?.length, 'MISSING_TARGET_ACKNOWLEDGEMENT');
            for (const ack of result.acknowledgements) {
                const key = ack.target + ':' + ack.scopeId;
                Check.require(!ids.has(key) && ack.ready && ack.generation === this.plan.compositionGeneration, 'INVALID_TARGET_ACKNOWLEDGEMENT');
                ids.add(key);
                acknowledgements.push(ack);
            }
        }
        acknowledgements.sort(ServiceApplications.ackOrder);
        await new ServiceRuntimeInspection(this.plan).audit();
        const resources: ServiceSnapshot['resources'] = [];
        for (const receipt of this.resources())
            resources.push({ resourceId: receipt.resourceId, kind: receipt.kind, serviceId: receipt.serviceId, creatingGeneration: receipt.creatingGeneration, receiptDigest: CanonicalJson.digest(receipt) });
        return ServiceSchemas.snapshot.parse({ formatVersion: 3, installationId: this.plan.configuration.installationId, installationDirectory: this.store.path, compositionGeneration: this.plan.compositionGeneration, resources, acknowledgements });
    }
    private async execute(initial: ServiceApplicationRecord): Promise<void> {
        let record = initial;
        try {
            await this.validate();
            record = this.event(record, 'stage');
            const prepared = new Map<string, PreparedServiceScope>();
            for (const service of this.plan.composition.services)
                prepared.set(service.serviceId, await ServiceNativeScope.prepare(this.plan, service.serviceId, this.writer));
            await new ServiceImages(this.plan).stage(this.writer);
            record = this.event(record, 'prepare');
            await new ServiceCredentials(this.plan).prepare(this.writer);
            if (this.plan.configuration.runtimeState === 'stopped') {
                record = this.event(record, 'commit');
                this.store.append({ ...record, sequence: record.sequence + 1, phase: 'completed', result: 'stopped' }, this.writer);
                return;
            }
            record = this.event(record, 'activate');
            for (const id of this.order()) {
                const scope = await ServiceNativeScope.open(this.plan, id, prepared.get(id)!, this.writer);
                this.scopes.set(id, scope);
                await this.observe(id);
            }
            record = this.event(record, 'readiness');
            const snapshot = await this.snapshot();
            this.store.saveSnapshot(snapshot, this.writer);
            record = this.event(record, 'commit');
            this.store.append({ ...record, sequence: record.sequence + 1, phase: 'completed', result: 'ready', activeComposition: this.plan.compositionGeneration, resourceSetDigest: CanonicalJson.digest(snapshot.resources), acknowledgements: snapshot.acknowledgements }, this.writer);
        }
        catch {
            const recovery = record.phase === 'validate' ? null : 'repair-required';
            this.store.append({ ...record, sequence: record.sequence + 1, phase: 'failed', result: 'failed', recovery }, this.writer);
        }
    }
    async status(): Promise<ServiceStatus> {
        const records = this.store.records(), last = records.at(-1), current = this.store.current(), services: ServiceStatus['services'] = [], blockers: ServiceStatus['blockers'] = [], freshAcks: ServiceStatus['acknowledgements'] = [];
        let ready = current !== null && !this.faulted;
        if (current) {
            try {
                await new ServiceRuntimeInspection(this.plan).audit();
            }
            catch {
                ready = false;
                blockers.push({ code: 'RESOURCE_IDENTITY_CHANGED', message: 'An installed resource requires verification.' });
            }
            const resources = this.resources();
            for (const service of this.plan.composition.services) {
                let qualified = false, observations: readonly string[] = ['service.unavailable'];
                try {
                    const scope = this.scopes.get(service.serviceId);
                    Check.require(scope, 'MISSING_NATIVE_SCOPE');
                    const result = await scope.ready();
                    qualified = result.ready;
                    observations = result.observations;
                    if (qualified)
                        for (const ack of result.acknowledgements ?? [])
                            freshAcks.push(ack);
                }
                catch { }
                let container: ServiceResourceReceipt | undefined;
                for (const receipt of resources)
                    if (receipt.kind === 'container' && receipt.serviceId === service.serviceId)
                        container = receipt;
                const change = this.plan.changes.find(ServiceApplications.named.bind(null, service.serviceId));
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
        return ServiceSchemas.status.parse({ formatVersion: 3, installationId: this.plan.configuration.installationId, engine: this.plan.expectedEngine.context, desiredComposition: last?.desiredComposition ?? null, activeComposition: current?.compositionGeneration ?? null, ready, plugins: [], blockers, applicationId: last?.id ?? null, services, resourceSetDigest: current ? CanonicalJson.digest(current.resources) : null, acknowledgements: ready ? freshAcks.sort(ServiceApplications.ackOrder) : [] });
    }
    async close(): Promise<void> {
        if (this.closed)
            return;
        this.closed = true;
        try {
            await this.job;
            for (const scope of this.scopes.values())
                await scope.close();
            this.scopes.clear();
        }
        finally {
            this.writer.close();
        }
    }
}
export class ServiceApplicationPlugin {
    static readonly provide = [ServiceApplicationToken.host.id];
    static readonly inject: string[] = [];
    static readonly Config = ServiceSchemas.plan;
    static readonly declaration = ProviderV4Schemas.declaration.parse({ id: 'deployment.application-host', pluginId: 'deployment', capability: ServiceApplicationToken.host.id, contractVersion: ProviderV4Schemas.version, target: 'deployment', provide: this.provide, inject: this.inject });
    private readonly host: ServiceApplications;
    constructor(context: Context, plan: ServicePlan) { this.host = new ServiceApplications(ServiceSchemas.plan.parse(plan)); context.provide(ServiceApplicationToken.host.id, this.host); context.effect(this.effect.bind(this)); }
    private effect(): () => Promise<void> { return this.host.close.bind(this.host); }
}
export class ServiceApplicationRuntime implements ServiceApplicationHost {
    private closed = false;
    private closing = false;
    private constructor(private readonly handle: CompositionHandle, private readonly context: Context) { }
    static async start(input: ServicePlan): Promise<ServiceApplicationRuntime> {
        const plan = ServiceSchemas.plan.parse(input), scopeId = 'installation:' + plan.configuration.installationId + ':host', handle = await CordisComposition.start({ registrations: [{ token: ServiceApplicationToken.host, plugin: ServiceApplicationPlugin, declaration: ServiceApplicationPlugin.declaration, configuration: plan, artifact: { kind: 'bundled', identity: 'deployment-application-host.1:' + plan.composition.worker.sha256 } }], selections: [{ scopeId, capability: ServiceApplicationToken.host.id, providerId: ServiceApplicationPlugin.declaration.id }] }, { scopeId, target: 'deployment', principalId: 'uid:' + process.getuid!(), resourceScope: plan.configuration.installationDirectory });
        const receiver: {
            context?: Context;
        } = {};
        class Consumer {
            static readonly inject = ['cordis.composition', ServiceApplicationToken.host.id];
            constructor(context: Context) { receiver.context = context; }
        }
        try {
            await handle.mount(Consumer, undefined);
            Check.require(receiver.context, 'NATIVE_HOST_SCOPE');
            return new ServiceApplicationRuntime(handle, receiver.context);
        }
        catch (error) {
            await handle.dispose();
            throw error;
        }
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

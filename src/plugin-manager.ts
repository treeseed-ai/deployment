import{RegisteredProviderSelection}from'./registered-selection.js';
import{GitSourceToken}from'./git-source.js';
import { join } from 'node:path';
import { CanonicalJson, CapabilityToken, PluginSource, PluginManagementSchemas, PlanningBlockedError, ProviderV4Schemas, ServiceSchemas, type PluginInstallRequest, type PluginSelectRequest, type PluginInstallResult, type PluginRequestRecord, type ServicePlan, type ServiceStatus, type PluginPackageDescriptor } from '@treeseed-cordis/sdk';
import { Context, CordisServiceLocator } from '@treeseed-cordis/sdk/runtime';
import { InstallationAuthority, InstallationAuthorityToken } from './service-authority.js';
import { PackageSourceTokens } from './npm-source.js';
import { PluginRequestStore } from './plugin-registry.js';
import { SourceClosureStore } from './source-closure.js';
import { PackageArchiveInspector } from './package-archive.js';
import { ServiceApplicationToken, type ServiceApplicationHost } from './service-application.js';
import { PreparedServiceRelease } from './prepared-release.js';
import { ContainerPluginSelection } from './plugin-selection.js';
import { PlanningFailure as Check } from './filesystem.js';

export interface PluginManager {
    install(request: PluginInstallRequest): Promise<PluginInstallResult>;
    select(request: PluginSelectRequest): Promise<PluginInstallResult>;
    list(scope?: PluginInstallRequest['scope'], target?: PluginInstallRequest['target']): Promise<PluginInstallResult[]>;
    inspect(requestId: string): Promise<PluginInstallResult>;
}
class ManagerAdapter {
    parse(value: unknown): PluginManager { Check.require(value !== null && typeof value === 'object', 'INVALID_PLUGIN_MANAGER'); for (const method of ['install', 'select', 'list', 'inspect']) Check.require(typeof Reflect.get(value, method) === 'function', 'INVALID_PLUGIN_MANAGER'); return value as PluginManager; }
}
export class PluginManagerToken {
    static readonly instance = new CapabilityToken<PluginManager>('deployment.plugins', ProviderV4Schemas.version, new ManagerAdapter());
}
/** Bounds the reply, not the accepted job. Native leases account for background work. */
class PendingPluginReply {
    private timer: ReturnType<typeof setTimeout> | undefined;
    private accept: ((result: PluginInstallResult) => void) | undefined;
    private reject: ((error: unknown) => void) | undefined;
    private settled = false;
    constructor(private readonly job: Promise<PluginInstallResult>, private readonly pending: () => PluginInstallResult) { }
    run(): Promise<PluginInstallResult> { return new Promise(this.start.bind(this)); }
    private start(accept: (result: PluginInstallResult) => void, reject: (error: unknown) => void): void { this.accept = accept; this.reject = reject; this.timer = setTimeout(this.expired.bind(this), 250); void this.job.then(this.done.bind(this), this.failed.bind(this)); }
    private done(result: PluginInstallResult): void { if (this.settled) return; this.settled = true; clearTimeout(this.timer); this.accept!(result); }
    private failed(error: unknown): void { if (this.settled) return; this.settled = true; clearTimeout(this.timer); this.reject!(error); }
    private expired(): void { if (this.settled) return; try { this.done(this.pending()); } catch (error) { this.failed(error); } }
}
/** Transaction bookkeeping only. Cordis owns provider instances, selection and disposal. */
class NativePluginManager implements PluginManager {
    private readonly requests: PluginRequestStore;
    private readonly jobs = new Map<string, Promise<PluginInstallResult>>();
    private closed = false;
    private faulted = false;
    constructor(private readonly authority: InstallationAuthority, private readonly locator: CordisServiceLocator) { this.requests = new PluginRequestStore(authority.plan, authority.writer); }
    private open(): void { Check.require(!this.closed, 'HOST_CLOSED'); this.authority.writer.assert(this.authority.store.path); }
    private record(id: string): PluginRequestRecord { for (const record of this.requests.records()) if (record.requestId === id) return record; return Check.block('PLUGIN_REQUEST_NOT_FOUND'); }
    private project(record: PluginRequestRecord, status?: ServiceStatus): PluginInstallResult {
        if (record.result) {
            if (NativePluginManager.activeRecord(record) && (!status?.ready || status.activeComposition !== record.result.activeGeneration)) return PluginManagementSchemas.result.parse({ ...record.result, state: 'prepared', activeGeneration: null, acknowledgements: [], blockers: [{ code: 'COMPOSITION_READBACK_REQUIRED', message: 'The historical request does not establish the current target generation.' }], nextActions: ['inspect-current-status'] });
            return PluginManagementSchemas.result.parse(record.result);
        }
        const uncertain = !this.jobs.has(record.requestId) && record.stage !== 'received' && record.stage !== 'acquired';
        return PluginManagementSchemas.result.parse({ requestId: record.requestId, pluginId: null, artifact: null, target: record.intent.target ?? null, planId: null, applicationId: null, previousGeneration: record.expectedGeneration, activeGeneration: null, state: this.faulted || uncertain ? 'recovery-required' : 'pending', blockers: this.faulted || uncertain ? [{ code: 'SOURCE_RESOLUTION_UNCERTAIN', message: 'The unfinished source request requires explicit repair.' }] : [], nextActions: this.faulted || uncertain ? ['repair-request'] : ['inspect-request'], acknowledgements: [] });
    }
    private static activeRecord(record: PluginRequestRecord): boolean { return record.result !== null && ['active', 'already-active'].includes(record.result.state); }
    private async status(): Promise<ServiceStatus> { const lease = await this.locator.acquire(ServiceApplicationToken.host); try { return await lease.value.status(); } finally { await lease.release(); } }
    private async checked(record: PluginRequestRecord): Promise<PluginInstallResult> { return this.project(record, NativePluginManager.activeRecord(record) ? await this.status() : undefined); }
    private pending(id: string): PluginInstallResult { return this.project(this.record(id)); }
    async install(input: PluginInstallRequest): Promise<PluginInstallResult> {
        this.open(); const request = PluginManagementSchemas.install.parse(input), policy = this.authority.plan.acquisitionPolicy;
        Check.require(policy, 'SOURCE_POLICY_REQUIRED'); Check.require(request.scope === 'installation', 'PLUGIN_SCOPE_NOT_SUPPORTED');
        const accepted = this.requests.begin(request, CanonicalJson.digest(policy), this.authority.store.current()?.compositionGeneration ?? null), record = accepted.record;
        if (record.result) return this.checked(record);
        let job = this.jobs.get(record.requestId);
        if (!job) { Check.require(!this.faulted, 'PLUGIN_MANAGER_REPAIR_REQUIRED'); job = this.execute(record).catch(this.failure.bind(this, record.requestId)).finally(this.finished.bind(this, record.requestId)); this.jobs.set(record.requestId, job); void job.catch(this.backgroundFailure.bind(this)); }
        return new PendingPluginReply(job, this.pending.bind(this, record.requestId)).run();
    }
    async select(input: PluginSelectRequest): Promise<PluginInstallResult> { this.open();const request=PluginManagementSchemas.select.parse(input),policy=this.authority.plan.acquisitionPolicy;Check.require(policy,'SOURCE_POLICY_REQUIRED');Check.require(request.scope==='installation','PLUGIN_SCOPE_NOT_SUPPORTED');const record=this.requests.begin(request,CanonicalJson.digest(policy),this.authority.store.current()?.compositionGeneration??null).record;if(record.result)return this.checked(record);let job=this.jobs.get(record.requestId);if(!job){Check.require(!this.faulted,'PLUGIN_MANAGER_REPAIR_REQUIRED');job=this.execute(record).catch(this.failure.bind(this,record.requestId)).finally(this.finished.bind(this,record.requestId));this.jobs.set(record.requestId,job);void job.catch(this.backgroundFailure.bind(this));}return new PendingPluginReply(job,this.pending.bind(this,record.requestId)).run(); }
    async list(scope: PluginInstallRequest['scope'] = 'installation', target?: PluginInstallRequest['target']): Promise<PluginInstallResult[]> { this.open(); Check.require(scope === 'installation', 'PLUGIN_SCOPE_NOT_SUPPORTED'); if (target !== undefined) PluginManagementSchemas.target.parse(target); const results: PluginInstallResult[] = [], records: PluginRequestRecord[] = []; for (const record of this.requests.records()) if (record.intent.scope === scope && (target === undefined || record.intent.target === target || record.result?.target === target)) records.push(record); const status = records.some(NativePluginManager.activeRecord) ? await this.status() : undefined; for (const record of records) results.push(this.project(record, status)); return results; }
    async inspect(requestId: string): Promise<PluginInstallResult> { this.open(); return this.checked(this.record(PluginManagementSchemas.key.parse(requestId))); }
    private async execute(initial: PluginRequestRecord): Promise<PluginInstallResult> {
        const owner = await this.locator.acquire(InstallationAuthorityToken.instance);
        try {
            let record = initial;
            Check.require(record.expectedGeneration === (this.authority.store.current()?.compositionGeneration ?? null), 'STALE_GENERATION');
            if(record.operation==='select')record=await new RegisteredProviderSelection(this.authority).acquire(record);
            else if (record.stage !== 'acquired') {
                const source = await this.locator.acquire(PluginSource.parse((record.intent as PluginInstallRequest).source).kind==='git'?GitSourceToken.instance:PackageSourceTokens.npm);
                try { record = await source.value.resolve(record); record = await source.value.acquire(record); }
                finally { await source.release(); }
            }
            const closure = await new SourceClosureStore(this.authority).read(record, record.sourceReceipt!.closureDigest);
            let root: typeof closure.packages[number] | undefined;
            for (const entry of closure.packages) if (entry.name === closure.root.name) root = entry;
            Check.require(root, 'SOURCE_CLOSURE_IDENTITY');
            const index = await PackageArchiveInspector.inspect(join(this.authority.store.path, '.cordis/artifacts/closures', record.sourceReceipt!.closureDigest, root.path), root.sha256), descriptor = PluginManagementSchemas.packageDescriptor.parse(index.metadata.cordisPackage), targets = new Set<string>();
            for (const provider of descriptor.providers) targets.add(provider.declaration.target);
            const target = PluginManagementSchemas.target.nullable().parse(record.intent.target ?? (targets.size === 1 ? [...targets][0] ?? null : null));
            Check.require(target === null || targets.has(target), 'PLUGIN_TARGET_MISMATCH');
            Check.require(record.expectedGeneration === (this.authority.store.current()?.compositionGeneration ?? null), 'STALE_GENERATION');
            return await this.activate(record, descriptor, target);
        } finally { await owner.release(); }
    }
    private base(): ServicePlan { const current = this.authority.store.current(); if (!current) return this.authority.plan; const records = this.authority.store.records(); for (let i = records.length - 1; i >= 0; i--) { const record = records[i]!; if (record.phase === 'completed' && record.activeComposition === current.compositionGeneration) return this.authority.store.read(record.planId, record.digest); } return Check.block('INVALID_ACTIVE_COMPOSITION'); }
    private save(record: PluginRequestRecord, result: PluginInstallResult): PluginInstallResult { return this.requests.append({ ...record, sequence: record.sequence + 1, stage: result.state === 'already-active' ? 'active' : result.state, result }).result!; }
    private static prepared(record: PluginRequestRecord, descriptor: PluginPackageDescriptor, target: PluginInstallResult['target'], actions: string[]): PluginInstallResult { return PluginManagementSchemas.result.parse({ requestId: record.requestId, pluginId: descriptor.pluginId, artifact: { package: record.sourceReceipt!.name, version: record.sourceReceipt!.version, integrity: record.sourceReceipt!.archiveDigest }, target, planId: null, applicationId: null, previousGeneration: record.expectedGeneration, activeGeneration: null, state: 'prepared', blockers: [], nextActions: actions, acknowledgements: [] }); }
    private static acknowledgements(plan: ServicePlan, serviceId: string, status: ServiceStatus): PluginInstallResult['acknowledgements'] {
        Check.require(status.ready && status.activeComposition === plan.compositionGeneration && status.acknowledgements.length, 'TARGET_ACKNOWLEDGEMENT_REQUIRED');
        const scope = 'installation:' + plan.configuration.installationId + ':service:' + serviceId, result: PluginInstallResult['acknowledgements'] = [];
        for (const ack of status.acknowledgements) if (ack.ready && ack.target === 'deployment' && ack.generation === plan.compositionGeneration && ack.scopeId === scope) result.push({ target: 'deployment', scopeId: scope, generation: ack.generation, ready: true });
        Check.require(result.length, 'TARGET_ACKNOWLEDGEMENT_REQUIRED'); return result;
    }
    private static actions(plan: ServicePlan): string[] { const result = new Set<string>(); for (const change of plan.changes) { for (const action of change.requiredActions) result.add(action === 'migration' ? 'review-migration' : action === 'restart' ? 'review-restart' : 'review-removal'); if (!['add', 'retain'].includes(change.kind) && !change.requiredActions.length) result.add('qualify-transition'); } if (plan.configuration.runtimeState !== 'running') result.add('start-runtime'); return [...result].sort(); }
    private installIntent(record:PluginRequestRecord,base:ServicePlan):PluginInstallRequest{if(record.operation==='install')return PluginManagementSchemas.install.parse(record.intent);const request=PluginManagementSchemas.select.parse(record.intent),{capability,...common}=request,bindings:Record<string,string>={};const prior=base.composition.services.find(NativePluginManager.named.bind(null,request.serviceId??''));if(prior)for(const binding of [...prior.bindings,...prior.dependencies])bindings[binding.port]=binding.bindingId;return PluginManagementSchemas.install.parse({...common,source:record.sourceReceipt!.locator,bindings:Object.keys(bindings).length?bindings:undefined});}
    private static named(id:string,value:{serviceId:string}):boolean{return id===value.serviceId;}
    private async activate(initial: PluginRequestRecord, descriptor: PluginPackageDescriptor, target: PluginInstallResult['target']): Promise<PluginInstallResult> {
        let record = initial; const base = this.base(), request = this.installIntent(record,base), template = NativePluginManager.prepared(record, descriptor, target, []), selection = ContainerPluginSelection.resolve(base, request, descriptor, record.sourceReceipt!, target);
        if(record.operation==='select'&&PluginManagementSchemas.select.parse(record.intent).capability!=='container.service')return this.save(record,{...template,nextActions:['qualify-transition']});
        if (selection.kind === 'prepared') return this.save(record, { ...template, nextActions: selection.actions });
        const lease = await this.locator.acquire(ServiceApplicationToken.host);
        try {
            if (this.authority.store.current()) {
                const status = await lease.value.status();
                if (!status.ready) return this.save(record, { ...template, nextActions: ['restore-readiness'] });
                if (CanonicalJson.stringify(selection.graph) === CanonicalJson.stringify(base.composition)) {
                    let applicationId: string | undefined; for (const application of this.authority.store.records()) if (application.phase === 'completed' && application.activeComposition === base.compositionGeneration) applicationId = application.id;
                    Check.require(applicationId, 'ACTIVE_COMPOSITION_REQUIRED');
                    return this.save(record, PluginManagementSchemas.result.parse({ ...template, state: 'already-active', planId: base.id, applicationId, activeGeneration: base.compositionGeneration, acknowledgements: NativePluginManager.acknowledgements(base, selection.serviceId, status) }));
                }
            }
            const configuration = await new PreparedServiceRelease(this.authority).prepare(record, selection.graph), plan = await lease.value.plan(configuration), actions = NativePluginManager.actions(plan);
            if (actions.length) return this.save(record, { ...template, planId: plan.id, nextActions: actions });
            const accepted = await lease.value.submit({ protocol: 3, operation: 'submit', planId: plan.id, digest: plan.digest, idempotencyKey: 'plugin-' + CanonicalJson.digest({ requestId: record.requestId, intentDigest: record.intentDigest, policyDigest: record.policyDigest }) });
            const pending = PluginManagementSchemas.result.parse({ ...template, state: 'pending', planId: plan.id, applicationId: accepted.id, nextActions: ['inspect-request'] });
            record = this.requests.append({ ...record, sequence: record.sequence + 1, stage: 'pending', result: pending });
            return await this.applied(record, plan, selection.serviceId, lease.value);
        } finally { await lease.release(); }
    }
    private async applied(record: PluginRequestRecord, plan: ServicePlan, serviceId: string, applications: ServiceApplicationHost): Promise<PluginInstallResult> {
        let application = await applications.application(record.result!.applicationId!);
        while (!['completed', 'failed', 'cancelled'].includes(application.phase)) { await new Promise(NativePluginManager.delay); application = await applications.application(application.id); }
        Check.require(application.planId === plan.id && application.digest === plan.digest && application.desiredComposition === plan.compositionGeneration, 'SOURCE_APPLICATION_BINDING');
        if (application.phase !== 'completed' || application.result !== 'ready') return this.save(record, PluginManagementSchemas.result.parse({ ...record.result, state: application.recovery ? 'recovery-required' : 'blocked', blockers: [{ code: 'PLUGIN_APPLICATION_FAILED', message: 'The selected application did not establish an active plugin.' }], nextActions: [application.recovery ? 'repair-installation' : 'review-application'] }));
        const status = await applications.status(), current = this.authority.store.current();
        Check.require(current?.compositionGeneration === plan.compositionGeneration && application.resourceSetDigest === CanonicalJson.digest(current.resources) && status.resourceSetDigest === application.resourceSetDigest, 'TARGET_ACKNOWLEDGEMENT_REQUIRED');
        return this.save(record, PluginManagementSchemas.result.parse({ ...record.result, state: 'active', activeGeneration: plan.compositionGeneration, blockers: [], nextActions: [], acknowledgements: NativePluginManager.acknowledgements(plan, serviceId, status) }));
    }
    private static delay(done: (value: void) => void): void { setTimeout(done, 50); }
    private failure(id: string, error: unknown): PluginInstallResult {
        if (!(error instanceof PlanningBlockedError)) throw error;
        const record = this.record(id), blockers = [];
        for (const blocker of error.blockers) if (/^[A-Z][A-Z0-9_]{0,62}$/.test(blocker.code)) blockers.push({ code: blocker.code, message: 'Plugin request blocked: ' + blocker.code + '.' });
        Check.require(blockers.length, 'PLUGIN_REQUEST_FAILED');
        const uncertain = blockers.some(NativePluginManager.uncertain), state = uncertain ? 'recovery-required' as const : 'blocked' as const, result = PluginManagementSchemas.result.parse({ ...this.project(record), state, blockers, nextActions: [uncertain ? 'repair-request' : 'review-request'] });
        return this.requests.append({ ...record, sequence: record.sequence + 1, stage: state, result }).result!;
    }
    private static uncertain(blocker: { code: string }): boolean { return /UNCERTAIN|INCOMPLETE|CHANGED|RECOVERY|REPAIR/.test(blocker.code); }
    private backgroundFailure(_error: unknown): void { this.faulted = true; }
    private finished(id: string): void { this.jobs.delete(id); }
    close(): void { this.closed = true; }
}
/** Host-private invariant provider; never installed inside acquired service scopes. */
export class PluginManagerPlugin {
    static readonly provide = [PluginManagerToken.instance.id];
    static readonly inject = ['cordis.composition', InstallationAuthorityToken.instance.id, PackageSourceTokens.npm.id, GitSourceToken.instance.id, ServiceApplicationToken.host.id];
    static readonly Config = ServiceSchemas.plan;
    static readonly declaration = ProviderV4Schemas.declaration.parse({ id: 'deployment.plugin-manager', pluginId: 'deployment', capability: PluginManagerToken.instance.id, contractVersion: ProviderV4Schemas.version, target: 'deployment', provide: this.provide, inject: this.inject });
    private readonly manager: NativePluginManager;
    constructor(context: Context, plan: ServicePlan) { const authority = InstallationAuthorityToken.instance.parse(Reflect.get(context, InstallationAuthorityToken.instance.id)); Check.require(CanonicalJson.stringify(authority.plan) === CanonicalJson.stringify(ServiceSchemas.plan.parse(plan)), 'PLAN_BINDING'); this.manager = new NativePluginManager(authority, CordisServiceLocator.from(context)); context.provide(PluginManagerToken.instance.id, this.manager); context.effect(this.effect.bind(this)); }
    private effect(): () => void { return this.manager.close.bind(this.manager); }
}

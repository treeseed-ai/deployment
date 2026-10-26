import { join } from 'node:path';
import { CanonicalJson, CapabilityToken, PluginManagementSchemas, PlanningBlockedError, ProviderV4Schemas, ServiceSchemas, type PluginInstallRequest, type PluginSelectRequest, type PluginInstallResult, type PluginRequestRecord, type ServicePlan } from '@treeseed-cordis/sdk';
import { Context, CordisServiceLocator } from '@treeseed-cordis/sdk/runtime';
import { InstallationAuthority, InstallationAuthorityToken } from './service-authority.js';
import { PackageSourceTokens } from './npm-source.js';
import { PluginRequestStore } from './plugin-registry.js';
import { SourceClosureStore } from './source-closure.js';
import { PackageArchiveInspector } from './package-archive.js';
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
    private project(record: PluginRequestRecord): PluginInstallResult {
        if (record.result) return PluginManagementSchemas.result.parse(record.result);
        const uncertain = !this.jobs.has(record.requestId) && record.stage !== 'received' && record.stage !== 'acquired';
        return PluginManagementSchemas.result.parse({ requestId: record.requestId, pluginId: null, artifact: null, target: record.intent.target ?? null, planId: null, applicationId: null, previousGeneration: record.expectedGeneration, activeGeneration: null, state: this.faulted || uncertain ? 'recovery-required' : 'pending', blockers: this.faulted || uncertain ? [{ code: 'SOURCE_RESOLUTION_UNCERTAIN', message: 'The unfinished source request requires explicit repair.' }] : [], nextActions: this.faulted || uncertain ? ['repair-request'] : ['inspect-request'], acknowledgements: [] });
    }
    private pending(id: string): PluginInstallResult { return this.project(this.record(id)); }
    async install(input: PluginInstallRequest): Promise<PluginInstallResult> {
        this.open(); const request = PluginManagementSchemas.install.parse(input), policy = this.authority.plan.acquisitionPolicy;
        Check.require(policy, 'SOURCE_POLICY_REQUIRED'); Check.require(request.scope === 'installation', 'PLUGIN_SCOPE_NOT_SUPPORTED');
        const accepted = this.requests.begin(request, CanonicalJson.digest(policy), this.authority.store.current()?.compositionGeneration ?? null), record = accepted.record;
        if (record.result) return this.project(record);
        let job = this.jobs.get(record.requestId);
        if (!job) { Check.require(!this.faulted, 'PLUGIN_MANAGER_REPAIR_REQUIRED'); job = this.execute(record).catch(this.failure.bind(this, record.requestId)).finally(this.finished.bind(this, record.requestId)); this.jobs.set(record.requestId, job); void job.catch(this.backgroundFailure.bind(this)); }
        return new PendingPluginReply(job, this.pending.bind(this, record.requestId)).run();
    }
    async select(input: PluginSelectRequest): Promise<PluginInstallResult> { this.open(); PluginManagementSchemas.select.parse(input); return Check.block('PLUGIN_SELECTION_NOT_QUALIFIED'); }
    async list(scope: PluginInstallRequest['scope'] = 'installation', target?: PluginInstallRequest['target']): Promise<PluginInstallResult[]> { this.open(); Check.require(scope === 'installation', 'PLUGIN_SCOPE_NOT_SUPPORTED'); if (target !== undefined) PluginManagementSchemas.target.parse(target); const results: PluginInstallResult[] = []; for (const record of this.requests.records()) if (record.intent.scope === scope && (target === undefined || record.intent.target === target || record.result?.target === target)) results.push(this.project(record)); return results; }
    async inspect(requestId: string): Promise<PluginInstallResult> { this.open(); return this.project(this.record(PluginManagementSchemas.key.parse(requestId))); }
    private async execute(initial: PluginRequestRecord): Promise<PluginInstallResult> {
        const owner = await this.locator.acquire(InstallationAuthorityToken.instance);
        try {
            let record = initial;
            Check.require(record.expectedGeneration === (this.authority.store.current()?.compositionGeneration ?? null), 'STALE_GENERATION');
            if (record.stage !== 'acquired') {
                const source = await this.locator.acquire(PackageSourceTokens.npm);
                try { record = await source.value.resolve(record); record = await source.value.acquire(record); }
                finally { await source.release(); }
            }
            const closure = await new SourceClosureStore(this.authority).read(record, record.sourceReceipt!.closureDigest);
            let root: typeof closure.packages[number] | undefined;
            for (const entry of closure.packages) if (entry.name === closure.root.name) root = entry;
            Check.require(root, 'SOURCE_CLOSURE_IDENTITY');
            const index = await PackageArchiveInspector.inspect(join(this.authority.store.path, '.cordis/artifacts/closures', record.sourceReceipt!.closureDigest, root.path), root.sha256), descriptor = PluginManagementSchemas.packageDescriptor.parse(index.metadata.cordisPackage), targets = new Set<string>();
            for (const provider of descriptor.providers) targets.add(provider.declaration.target);
            const target = record.intent.target ?? (targets.size === 1 ? [...targets][0] ?? null : null);
            Check.require(target === null || targets.has(target), 'PLUGIN_TARGET_MISMATCH');
            Check.require(record.expectedGeneration === (this.authority.store.current()?.compositionGeneration ?? null), 'STALE_GENERATION');
            const result = PluginManagementSchemas.result.parse({ requestId: record.requestId, pluginId: descriptor.pluginId, artifact: { package: record.sourceReceipt!.name, version: record.sourceReceipt!.version, integrity: record.sourceReceipt!.archiveDigest }, target, planId: null, applicationId: null, previousGeneration: record.expectedGeneration, activeGeneration: null, state: 'prepared', blockers: [], nextActions: [target === null ? 'select-target' : 'select-provider'], acknowledgements: [] });
            record = this.requests.append({ ...record, sequence: record.sequence + 1, stage: 'prepared', result }); return record.result!;
        } finally { await owner.release(); }
    }
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
    static readonly inject = ['cordis.composition', InstallationAuthorityToken.instance.id, PackageSourceTokens.npm.id];
    static readonly Config = ServiceSchemas.plan;
    static readonly declaration = ProviderV4Schemas.declaration.parse({ id: 'deployment.plugin-manager', pluginId: 'deployment', capability: PluginManagerToken.instance.id, contractVersion: ProviderV4Schemas.version, target: 'deployment', provide: this.provide, inject: this.inject });
    private readonly manager: NativePluginManager;
    constructor(context: Context, plan: ServicePlan) { const authority = InstallationAuthorityToken.instance.parse(Reflect.get(context, InstallationAuthorityToken.instance.id)); Check.require(CanonicalJson.stringify(authority.plan) === CanonicalJson.stringify(ServiceSchemas.plan.parse(plan)), 'PLAN_BINDING'); this.manager = new NativePluginManager(authority, CordisServiceLocator.from(context)); context.provide(PluginManagerToken.instance.id, this.manager); context.effect(this.effect.bind(this)); }
    private effect(): () => void { return this.manager.close.bind(this.manager); }
}

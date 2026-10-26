import {PackageClosureAcquirer} from './source-closure.js';
import { PreparedServiceRelease } from './prepared-release.js';
import { ServiceApplicationRuntime } from './service-application.js';
import { SourceArchiveCache, type ResolvedPackageArchive } from './source-archive.js';
import { CanonicalJson, CapabilityToken, PluginSource, PluginManagementSchemas, ProviderV4Schemas, ServiceSchemas, type ServicePlan, type PluginRequestRecord, type PluginInstallRequest } from '@treeseed-cordis/sdk';
import { Context, CordisServiceLocator, type CompositionHandle } from '@treeseed-cordis/sdk/runtime';
import { InstallationAuthority, InstallationAuthorityToken } from './service-authority.js';
import { PluginRequestStore } from './plugin-registry.js';
import {NpmRegistryLookup} from './source-registry.js';
import { ManagedReleaseCache } from './release-cache.js';
import { InstallationStore } from './installed.js';
import { SafeDirectory, PlanningFailure as Check } from './filesystem.js';
export interface PackageSourceResolver {
    acquire(record:PluginRequestRecord):Promise<PluginRequestRecord>;
    fetch(record: PluginRequestRecord): Promise<ResolvedPackageArchive>;
    resolve(record: PluginRequestRecord): Promise<PluginRequestRecord>;
}
class SourceAdapter {
    parse(value: unknown): PackageSourceResolver { Check.require(value !== null && typeof value === 'object' && typeof Reflect.get(value, 'resolve') === 'function' && typeof Reflect.get(value, 'fetch') === 'function' && typeof Reflect.get(value,'acquire')==='function', 'INVALID_SOURCE_ADAPTER'); return value as PackageSourceResolver; }
}
export class PackageSourceTokens {
    static readonly npm = new CapabilityToken<PackageSourceResolver>('source.npm', ProviderV4Schemas.version, new SourceAdapter());
}
class NpmPackageSource implements PackageSourceResolver {
    private readonly requests: PluginRequestStore;
    private readonly jobs=new Map<string,Promise<PluginRequestRecord>>();
    constructor(private readonly authority: InstallationAuthority) { this.requests = new PluginRequestStore(authority.plan, authority.writer); }
    private current(input: PluginRequestRecord): PluginRequestRecord {
        const record = PluginManagementSchemas.install.parse(input.intent);
        for (const current of this.requests.records())
            if (current.requestId === input.requestId) {
                Check.require(CanonicalJson.stringify(current.intent) === CanonicalJson.stringify(record) && current.policyDigest === input.policyDigest && current.intentDigest === input.intentDigest && current.expectedGeneration === input.expectedGeneration, 'IDEMPOTENCY_CONFLICT');
                return current;
            }
        return Check.block('PLUGIN_REQUEST_NOT_FOUND');
    }
    acquire(input:PluginRequestRecord):Promise<PluginRequestRecord>{const record=this.current(input),existing=this.jobs.get(record.requestId);if(existing)return existing;const job=new PackageClosureAcquirer(this.authority,this).acquire(record).finally(this.finished.bind(this,record.requestId));this.jobs.set(record.requestId,job);return job;}
    private finished(id:string):void{this.jobs.delete(id);}
    async fetch(input: PluginRequestRecord): Promise<ResolvedPackageArchive> { const record = this.current(input), policy = this.authority.plan.acquisitionPolicy; Check.require(policy && record.policyDigest === CanonicalJson.digest(policy) && ['resolved','acquired','prepared','pending','active'].includes(record.stage) && record.resolution?.kind === 'npm', 'SOURCE_RESOLUTION_REQUIRED'); const intent = PluginManagementSchemas.install.parse(record.intent), resolution = record.resolution; let granted = false; let certificate: Buffer | undefined; for (const grant of policy.npm)
        if (grant.registry === resolution.registry && grant.packages.includes(resolution.name) && (intent.target ? grant.targets.includes(intent.target) : grant.targets.length === 1)) {
            Check.require(!granted, 'NPM_SOURCE_NOT_APPROVED');
            granted = true;
            if (grant.certificateAuthority) {
                const release = new ManagedReleaseCache(this.authority.plan).open();
                Check.require(release, 'SOURCE_TRUST_UNAVAILABLE');
                try {
                    certificate = release.read(grant.certificateAuthority.path);
                }
                finally {
                    release.close();
                }
            }
        } Check.require(granted, 'NPM_SOURCE_NOT_APPROVED'); return new SourceArchiveCache(this.authority, record).fetch(certificate); }
    async resolve(input: PluginRequestRecord): Promise<PluginRequestRecord> {
        let record = this.current(input);
        const plan = this.authority.plan, policy = plan.acquisitionPolicy;
        Check.require(record.operation === 'install' && policy && record.policyDigest === CanonicalJson.digest(policy), 'SOURCE_POLICY_REQUIRED');
        const intent = PluginManagementSchemas.install.parse(record.intent), locator = PluginSource.parse(intent.source);
        Check.require(locator.kind === 'npm', 'NPM_SOURCE_REQUIRED');
        if (record.resolution?.kind === 'npm')
            return record;
        Check.require(record.stage === 'received', 'SOURCE_RESOLUTION_UNCERTAIN');
        Check.require(record.expectedGeneration === (this.authority.store.current()?.compositionGeneration ?? null), 'STALE_GENERATION');
        const grant=NpmRegistryLookup.grant(plan,locator.name,intent.target),lookup=new NpmRegistryLookup(this.authority);
        record = this.requests.append({ ...record, sequence: record.sequence + 1, stage: 'resolving' });
        const release = await new ManagedReleaseCache(plan).stage(this.authority.writer, record);
        let artifacts: SafeDirectory | undefined, work: SafeDirectory | undefined;
        try {
            artifacts = this.authority.store.directory('artifacts', this.authority.writer);
            const name = 'source-resolution-' + CanonicalJson.digest({ requestId: record.requestId, intentDigest: record.intentDigest, policyDigest: record.policyDigest });
            Check.require(!artifacts.entries().includes(name), 'SOURCE_RESOLUTION_UNCERTAIN');
            work = InstallationStore.mkdir(artifacts, name);
            const resolution=await lookup.read(intent.source,grant,record,work,release);
            return this.requests.append({ ...record, sequence: record.sequence + 1, stage: 'resolved', resolution });
        }
        finally {
            work?.close();
            artifacts?.close();
            release.close();
        }
    }
}
/** Host-private native provider; never grants the installation writer to acquired packages. */
export class NpmSourcePlugin {
    static readonly provide = [PackageSourceTokens.npm.id];
    static readonly inject = [InstallationAuthorityToken.instance.id];
    static readonly Config = ServiceSchemas.plan;
    static readonly declaration = ProviderV4Schemas.declaration.parse({ id: 'deployment.npm-source', pluginId: 'deployment', capability: PackageSourceTokens.npm.id, contractVersion: ProviderV4Schemas.version, target: 'deployment', provide: this.provide, inject: this.inject });
    constructor(context: Context, plan: ServicePlan) { const authority = InstallationAuthorityToken.instance.parse(Reflect.get(context, InstallationAuthorityToken.instance.id)); Check.require(CanonicalJson.stringify(authority.plan) === CanonicalJson.stringify(ServiceSchemas.plan.parse(plan)), 'PLAN_BINDING'); context.provide(PackageSourceTokens.npm.id, new NpmPackageSource(authority)); }
}
/** Default standalone composition for source qualification; host adopts the same plugin. */
export class NpmSourceRuntime extends ServiceApplicationRuntime implements PackageSourceResolver {
    private sourceClosed = false;
    private constructor(handle: CompositionHandle, context: Context, private readonly authority: InstallationAuthority) { super(handle, context); }
    static async start(input: ServicePlan): Promise<NpmSourceRuntime> {
        const plan = ServiceSchemas.plan.parse(input), artifact = { kind: 'bundled' as const, identity: 'deployment-source.1:' + plan.composition.worker.sha256 }, scope = await this.mount(plan, [{ token: PackageSourceTokens.npm, plugin: NpmSourcePlugin, declaration: NpmSourcePlugin.declaration, configuration: plan, artifact }]);
        const authority = InstallationAuthorityToken.instance.parse(Reflect.get(scope.context, InstallationAuthorityToken.instance.id));
        return new NpmSourceRuntime(scope.handle, scope.context, authority);
    }
    begin(source: string, key: string, target: PluginInstallRequest['target'] = 'deployment'): PluginRequestRecord { Check.require(!this.sourceClosed && this.authority.plan.acquisitionPolicy, 'SOURCE_POLICY_REQUIRED'); const intent: PluginInstallRequest = { source, idempotencyKey: key, installationDirectory: this.authority.plan.configuration.installationDirectory, scope: 'installation', target, configuration: {} }; return new PluginRequestStore(this.authority.plan, this.authority.writer).begin(intent, CanonicalJson.digest(this.authority.plan.acquisitionPolicy), this.authority.store.current()?.compositionGeneration ?? null).record; }
    async resolve(record: PluginRequestRecord): Promise<PluginRequestRecord> {
        Check.require(!this.sourceClosed, 'HOST_CLOSED');
        const lease = await CordisServiceLocator.from(this.context).acquire(PackageSourceTokens.npm);
        try {
            return await lease.value.resolve(record);
        }
        finally {
            await lease.release();
        }
    }
    async fetch(record: PluginRequestRecord): Promise<ResolvedPackageArchive> { Check.require(!this.sourceClosed, 'HOST_CLOSED'); const lease = await CordisServiceLocator.from(this.context).acquire(PackageSourceTokens.npm); try {
        return await lease.value.fetch(record);
    }
    finally {
        await lease.release();
    } }
    async acquire(record:PluginRequestRecord):Promise<PluginRequestRecord>{Check.require(!this.sourceClosed,'HOST_CLOSED');const lease=await CordisServiceLocator.from(this.context).acquire(PackageSourceTokens.npm);try{return await lease.value.acquire(record);}finally{await lease.release();}}
    async prepare(record: PluginRequestRecord, composition: ServicePlan['composition']): Promise<ServicePlan['configuration']> { Check.require(!this.sourceClosed, 'HOST_CLOSED'); const lease = await CordisServiceLocator.from(this.context).acquire(InstallationAuthorityToken.instance); try { return await new PreparedServiceRelease(lease.value).prepare(record, composition); } finally { await lease.release(); } }
    async close(timeoutMs = 10000): Promise<void> { this.sourceClosed = true; await super.close(timeoutMs); }
}

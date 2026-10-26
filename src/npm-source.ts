import { SourceArchiveCache, type ResolvedPackageArchive } from './source-archive.js';
import { CanonicalJson, CapabilityToken, PluginSource, PluginManagementSchemas, ProviderV4Schemas, ServiceSchemas, type ServicePlan, type PluginRequestRecord, type PluginInstallRequest } from '@treeseed-cordis/sdk';
import { Context, CordisComposition, CordisServiceLocator, type CompositionHandle } from '@treeseed-cordis/sdk/runtime';
import { InstallationAuthority, InstallationAuthorityPlugin, InstallationAuthorityToken } from './service-authority.js';
import { PluginRequestStore } from './plugin-registry.js';
import {NpmRegistryLookup} from './source-registry.js';
import { ManagedReleaseCache } from './release-cache.js';
import { InstallationStore } from './installed.js';
import { SafeDirectory, PlanningFailure as Check } from './filesystem.js';
export interface PackageSourceResolver {
    fetch(record: PluginRequestRecord): Promise<ResolvedPackageArchive>;
    resolve(record: PluginRequestRecord): Promise<PluginRequestRecord>;
}
class SourceAdapter {
    parse(value: unknown): PackageSourceResolver { Check.require(value !== null && typeof value === 'object' && typeof Reflect.get(value, 'resolve') === 'function' && typeof Reflect.get(value, 'fetch') === 'function', 'INVALID_SOURCE_ADAPTER'); return value as PackageSourceResolver; }
}
export class PackageSourceTokens {
    static readonly npm = new CapabilityToken<PackageSourceResolver>('source.npm', ProviderV4Schemas.version, new SourceAdapter());
}
class NpmPackageSource implements PackageSourceResolver {
    private readonly requests: PluginRequestStore;
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
    async fetch(input: PluginRequestRecord): Promise<ResolvedPackageArchive> { const record = this.current(input), policy = this.authority.plan.acquisitionPolicy; Check.require(policy && record.policyDigest === CanonicalJson.digest(policy) && record.stage === 'resolved' && record.resolution?.kind === 'npm', 'SOURCE_RESOLUTION_REQUIRED'); const intent = PluginManagementSchemas.install.parse(record.intent), resolution = record.resolution; let granted = false; let certificate: Buffer | undefined; for (const grant of policy.npm)
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
        if (record.stage === 'resolved' && record.resolution?.kind === 'npm')
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
export class NpmSourceRuntime implements PackageSourceResolver {
    private closed = false;
    private constructor(private readonly handle: CompositionHandle, private readonly context: Context, private readonly authority: InstallationAuthority) { }
    static async start(input: ServicePlan): Promise<NpmSourceRuntime> {
        const plan = ServiceSchemas.plan.parse(input), artifact = { kind: 'bundled' as const, identity: 'deployment-source.1:' + plan.composition.worker.sha256 }, scopeId = 'installation:' + plan.configuration.installationId + ':source', registrations = [{ token: InstallationAuthorityToken.instance, plugin: InstallationAuthorityPlugin, declaration: InstallationAuthorityPlugin.declaration, configuration: { plan }, artifact }, { token: PackageSourceTokens.npm, plugin: NpmSourcePlugin, declaration: NpmSourcePlugin.declaration, configuration: plan, artifact }], selections = [];
        for (const registration of registrations)
            selections.push({ scopeId, capability: registration.token.id, providerId: registration.declaration.id });
        const handle = await CordisComposition.start({ registrations, selections }, { scopeId, target: 'deployment', principalId: 'uid:' + process.getuid!(), resourceScope: plan.configuration.installationDirectory }), receiver: {
            context?: Context;
        } = {};
        class Consumer {
            static readonly inject = ['cordis.composition', InstallationAuthorityToken.instance.id, PackageSourceTokens.npm.id];
            constructor(context: Context) { receiver.context = context; }
        }
        try {
            await handle.mount(Consumer, undefined);
            Check.require(receiver.context, 'NATIVE_SOURCE_SCOPE');
            const authority = InstallationAuthorityToken.instance.parse(Reflect.get(receiver.context, InstallationAuthorityToken.instance.id));
            return new NpmSourceRuntime(handle, receiver.context, authority);
        }
        catch (error) {
            await handle.dispose();
            throw error;
        }
    }
    begin(source: string, key: string, target: PluginInstallRequest['target'] = 'deployment'): PluginRequestRecord { Check.require(!this.closed && this.authority.plan.acquisitionPolicy, 'SOURCE_POLICY_REQUIRED'); const intent: PluginInstallRequest = { source, idempotencyKey: key, installationDirectory: this.authority.plan.configuration.installationDirectory, scope: 'installation', target, configuration: {} }; return new PluginRequestStore(this.authority.plan, this.authority.writer).begin(intent, CanonicalJson.digest(this.authority.plan.acquisitionPolicy), this.authority.store.current()?.compositionGeneration ?? null).record; }
    async resolve(record: PluginRequestRecord): Promise<PluginRequestRecord> {
        Check.require(!this.closed, 'HOST_CLOSED');
        const lease = await CordisServiceLocator.from(this.context).acquire(PackageSourceTokens.npm);
        try {
            return await lease.value.resolve(record);
        }
        finally {
            await lease.release();
        }
    }
    async fetch(record: PluginRequestRecord): Promise<ResolvedPackageArchive> { Check.require(!this.closed, 'HOST_CLOSED'); const lease = await CordisServiceLocator.from(this.context).acquire(PackageSourceTokens.npm); try {
        return await lease.value.fetch(record);
    }
    finally {
        await lease.release();
    } }
    async close(): Promise<void> {
        if (this.closed)
            return;
        this.closed = true;
        await this.handle.dispose();
    }
}

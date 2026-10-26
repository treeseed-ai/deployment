import { createHash } from 'node:crypto';
import { openSync, closeSync, fstatSync, lstatSync, constants, type Stats } from 'node:fs';
import { valid, satisfies, validRange } from 'semver';
import { CanonicalJson, CapabilityToken, PluginSource, PluginManagementSchemas, ProviderV4Schemas, ServiceSchemas, PlatformSchemas, type ServicePlan, type PluginRequestRecord, type PluginInstallRequest } from '@treeseed-cordis/sdk';
import { Context, CordisComposition, CordisServiceLocator, type CompositionHandle } from '@treeseed-cordis/sdk/runtime';
import { InstallationAuthority, InstallationAuthorityPlugin, InstallationAuthorityToken } from './service-authority.js';
import { PluginRequestStore } from './plugin-registry.js';
import { ManagedSourceTools } from './managed-tools.js';
import { ManagedReleaseCache } from './release-cache.js';
import { InstallationStore } from './installed.js';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';
export interface PackageSourceResolver {
    resolve(record: PluginRequestRecord): Promise<PluginRequestRecord>;
}
class SourceAdapter {
    parse(value: unknown): PackageSourceResolver { Check.require(value !== null && typeof value === 'object' && typeof Reflect.get(value, 'resolve') === 'function', 'INVALID_SOURCE_ADAPTER'); return value as PackageSourceResolver; }
}
export class PackageSourceTokens {
    static readonly npm = new CapabilityToken<PackageSourceResolver>('source.npm', ProviderV4Schemas.version, new SourceAdapter());
}
/** The helper opens this held descriptor; path replacement cannot change its trust source. */
class SourceTrust {
    private readonly fd: number;
    private readonly identity: Stats;
    constructor(private readonly directory: SafeDirectory, bytes: Buffer, private readonly digest: string) { InstallationStore.publish(directory, 'source-ca.pem', bytes, 0o400); this.fd = openSync(directory.childPath('source-ca.pem'), constants.O_RDONLY | constants.O_NOFOLLOW); this.identity = fstatSync(this.fd); try {
        this.verify();
    }
    catch (error) {
        closeSync(this.fd);
        throw error;
    } }
    path(): string { return '/proc/' + process.pid + '/fd/' + this.fd; }
    verify(): void { const before = this.identity, after = fstatSync(this.fd), linked = lstatSync(this.directory.childPath('source-ca.pem')); Check.require(after.isFile() && after.uid === process.getuid?.() && after.nlink === 1 && (after.mode & 0o777) === 0o400 && after.dev === before.dev && after.ino === before.ino && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && linked.dev === before.dev && linked.ino === before.ino, 'SOURCE_CA_CHANGED'); this.directory.file('source-ca.pem', this.digest, 1024 * 1024); this.directory.verify(); }
    close(): void { closeSync(this.fd); }
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
        const grants = [];
        for (const grant of policy.npm)
            if (grant.packages.includes(locator.name) && (intent.target ? grant.targets.includes(intent.target) : grant.targets.length === 1))
                grants.push(grant);
        Check.require(grants.length === 1, 'NPM_SOURCE_NOT_APPROVED');
        const grant = grants[0]!;
        Check.require(plan.helpers && plan.helpers.releaseIdentity === policy.helperReleaseIdentity, 'UNAPPROVED_HELPER_RELEASE');
        let helper;
        for (const candidate of plan.helpers.helpers)
            if (candidate.id === 'bun')
                helper = candidate;
        Check.require(helper, 'SOURCE_HELPER_UNAVAILABLE');
        record = this.requests.append({ ...record, sequence: record.sequence + 1, stage: 'resolving' });
        const release = await new ManagedReleaseCache(plan).stage(this.authority.writer, record);
        let artifacts: SafeDirectory | undefined, work: SafeDirectory | undefined, trust: SourceTrust | undefined;
        try {
            artifacts = this.authority.store.directory('artifacts', this.authority.writer);
            const name = 'source-resolution-' + CanonicalJson.digest({ requestId: record.requestId, intentDigest: record.intentDigest, policyDigest: record.policyDigest });
            Check.require(!artifacts.entries().includes(name), 'SOURCE_RESOLUTION_UNCERTAIN');
            work = InstallationStore.mkdir(artifacts, name);
            const args = ['info', intent.source, '--json', '--registry=' + grant.registry, '--no-cache', '--ignore-scripts', '--no-env-file'];
            if (grant.certificateAuthority) {
                const bytes = release.read(grant.certificateAuthority.path);
                Check.require(createHash('sha256').update(bytes).digest('hex') === grant.certificateAuthority.sha256, 'SOURCE_CA_CHANGED');
                trust = new SourceTrust(work, bytes, grant.certificateAuthority.sha256);
                args.push('--cafile=' + trust.path());
            }
            const tools = new ManagedSourceTools(plan, this.authority.writer, policy.helperReleaseIdentity);
            Check.require(await tools.version('bun', record) === helper.version, 'SOURCE_HELPER_VERSION');
            const metadataBytes = await tools.run('bun', args, work.path, record);
            trust?.verify();
            const metadata = StrictJson.object(StrictJson.parse(metadataBytes)), dist = StrictJson.object(metadata.dist);
            Check.require(metadata.name === locator.name && typeof metadata.version === 'string' && PlatformSchemas.version.safeParse(metadata.version).success && valid(metadata.version) !== null, 'NPM_METADATA_IDENTITY');
            if (validRange(locator.selector) !== null)
                Check.require(satisfies(metadata.version, locator.selector), 'NPM_SELECTOR_MISMATCH');
            Check.require(typeof dist.tarball === 'string' && PluginSource.https(dist.tarball) && typeof dist.integrity === 'string', 'NPM_METADATA_INTEGRITY');
            const registry = new URL(grant.registry), tarball = new URL(dist.tarball);
            Check.require(tarball.origin === registry.origin && tarball.pathname.startsWith(registry.pathname.endsWith('/') ? registry.pathname : registry.pathname + '/'), 'NPM_TARBALL_ORIGIN');
            const sri = /^(sha256|sha512)-([a-zA-Z0-9+/]+=*)$/.exec(dist.integrity);
            Check.require(sri && Buffer.from(sri[2]!, 'base64').toString('base64') === sri[2] && Buffer.from(sri[2]!, 'base64').length === (sri[1] === 'sha256' ? 32 : 64), 'NPM_METADATA_INTEGRITY');
            const resolution = PluginManagementSchemas.resolution.parse({ kind: 'npm', registry: grant.registry, name: locator.name, version: metadata.version, tarball: dist.tarball, sri: dist.integrity, metadataDigest: CanonicalJson.digest(metadata), helperDigests: [helper.sha256] });
            InstallationStore.publish(work, 'metadata.json', metadata);
            work.verify();
            return this.requests.append({ ...record, sequence: record.sequence + 1, stage: 'resolved', resolution });
        }
        finally {
            trust?.close();
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
    async close(): Promise<void> {
        if (this.closed)
            return;
        this.closed = true;
        await this.handle.dispose();
    }
}

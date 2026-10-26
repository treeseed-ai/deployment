import { createHash } from 'node:crypto';
import { openSync, closeSync, fstatSync, lstatSync, constants, type Stats } from 'node:fs';
import { valid, satisfies, validRange } from 'semver';
import { CanonicalJson, PluginSource, PluginManagementSchemas, PlatformSchemas, type ServicePlan, type PluginRequestRecord, type PluginInstallRequest, type SourceToolDefinition, type SourceAcquisitionPolicy } from '@treeseed-cordis/sdk';
import { InstallationAuthority } from './service-authority.js';
import { ManagedSourceTools } from './managed-tools.js';
import { type ManagedReleaseReader } from './release-cache.js';
import { InstallationStore } from './installed.js';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';
export type NpmResolution = Extract<NonNullable<PluginRequestRecord['resolution']>, {
    kind: 'npm';
}>;
export type RegistryGrant = SourceAcquisitionPolicy['npm'][number];
/** The helper opens this held descriptor; path replacement cannot change its trust source. */
class SourceTrust {
    private readonly fd: number;
    private readonly identity: Stats;
    constructor(private readonly directory: SafeDirectory, bytes: Buffer, private readonly digest: string) {
        InstallationStore.publish(directory, 'source-ca.pem', bytes, 0o400);
        this.fd = openSync(directory.childPath('source-ca.pem'), constants.O_RDONLY | constants.O_NOFOLLOW);
        this.identity = fstatSync(this.fd);
        try {
            this.verify();
        }
        catch (error) {
            closeSync(this.fd);
            throw error;
        }
    }
    path(): string { return '/proc/' + process.pid + '/fd/' + this.fd; }
    verify(): void { const before = this.identity, after = fstatSync(this.fd), linked = lstatSync(this.directory.childPath('source-ca.pem')); Check.require(after.isFile() && after.uid === process.getuid?.() && after.nlink === 1 && (after.mode & 0o777) === 0o400 && after.dev === before.dev && after.ino === before.ino && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && linked.dev === before.dev && linked.ino === before.ino, 'SOURCE_CA_CHANGED'); this.directory.file('source-ca.pem', this.digest, 1024 * 1024); this.directory.verify(); }
    close(): void { closeSync(this.fd); }
}
/** Shared invariant for root and dependency metadata; no second resolver or authority. */
export class NpmRegistryLookup {
    private readonly helper: SourceToolDefinition;
    private readonly releaseIdentity: string;
    constructor(private readonly authority: InstallationAuthority) { const plan = authority.plan, policy = plan.acquisitionPolicy; Check.require(policy && plan.helpers && plan.helpers.releaseIdentity === policy.helperReleaseIdentity, 'UNAPPROVED_HELPER_RELEASE'); let helper; for (const candidate of plan.helpers.helpers)
        if (candidate.id === 'bun')
            helper = candidate; Check.require(helper, 'SOURCE_HELPER_UNAVAILABLE'); this.helper = helper; this.releaseIdentity = policy.helperReleaseIdentity; }
    static grant(plan: ServicePlan, name: string, target: PluginInstallRequest['target'], registry?: string): RegistryGrant { const matches = []; for (const grant of plan.acquisitionPolicy?.npm ?? [])
        if (grant.packages.includes(name) && (target ? grant.targets.includes(target) : grant.targets.length === 1) && (registry === undefined || grant.registry === registry))
            matches.push(grant); Check.require(matches.length === 1, 'NPM_SOURCE_NOT_APPROVED'); return matches[0]!; }
    async read(source: string, grant: RegistryGrant, record: PluginRequestRecord, work: SafeDirectory, release: ManagedReleaseReader): Promise<NpmResolution> {
        const locator = PluginSource.parse(source);
        Check.require(locator.kind === 'npm', 'NPM_SOURCE_REQUIRED');
        let trust: SourceTrust | undefined;
        try {
            const args = ['info', source, '--json', '--registry=' + grant.registry, '--no-cache', '--ignore-scripts', '--no-env-file'];
            if (grant.certificateAuthority) {
                const bytes = release.read(grant.certificateAuthority.path);
                Check.require(createHash('sha256').update(bytes).digest('hex') === grant.certificateAuthority.sha256, 'SOURCE_CA_CHANGED');
                trust = new SourceTrust(work, bytes, grant.certificateAuthority.sha256);
                args.push('--cafile=' + trust.path());
            }
            const tools = new ManagedSourceTools(this.authority.plan, this.authority.writer, this.releaseIdentity);
            Check.require(await tools.version('bun', record) === this.helper.version, 'SOURCE_HELPER_VERSION');
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
            const resolution = PluginManagementSchemas.resolution.parse({ kind: 'npm', registry: grant.registry, name: locator.name, version: metadata.version, tarball: dist.tarball, sri: dist.integrity, metadataDigest: CanonicalJson.digest(metadata), helperDigests: [this.helper.sha256] });
            InstallationStore.publish(work, 'metadata.json', metadata);
            work.verify();
            Check.require(resolution.kind==='npm','NPM_METADATA_IDENTITY');
            return resolution;
        }
        finally {
            trust?.close();
        }
    }
}

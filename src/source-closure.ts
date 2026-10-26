import { GitArchiveCache } from './git-archive.js';
import { createHash } from 'node:crypto';
import { fstatSync, lstatSync, fchmodSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { validRange, satisfies } from 'semver';
import { z } from 'zod';
import { CanonicalJson, PlatformSchemas, ServiceSchemas, PluginManagementSchemas, type PluginRequestRecord, type ServicePlan, type PluginPackageDescriptor } from '@treeseed-cordis/sdk';
import { ArtifactResolver, type PackageData } from './artifacts.js';
import { PackageArchiveInspector, type PackageArchiveIndex } from './package-archive.js';
import { InstallationAuthority } from './service-authority.js';
import { InstallationStore } from './installed.js';
import { ManagedReleaseCache, type ManagedReleaseReader } from './release-cache.js';
import { ManagedSourceTools } from './managed-tools.js';
import { NpmRegistryLookup } from './source-registry.js';
import { SourceArchiveCache } from './source-archive.js';
import { PluginRequestStore } from './plugin-registry.js';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';
interface RootArchive {
    descriptor:PluginPackageDescriptor;
    path: string;
    sha256: string;
    size: number;
}
interface RootSources {
    fetch(record: PluginRequestRecord): Promise<RootArchive>;
}
class ClosureSchemas {
    static readonly entry = z.strictObject({ name: PlatformSchemas.packageName, version: PlatformSchemas.version, path: PlatformSchemas.relative, sha256: PlatformSchemas.digest });
    static readonly manifest = z.strictObject({ formatVersion: z.literal(1), baseReleaseDigest: PlatformSchemas.digest, root: z.strictObject({ name: PlatformSchemas.packageName, version: PlatformSchemas.version, sha256: PlatformSchemas.digest, sri: z.string().regex(/^sha(?:256|512)-[A-Za-z0-9+/]+=*$/) }), packageJson: PlatformSchemas.file, lockfile: PlatformSchemas.file, packages: z.array(this.entry).min(1).max(1024) });
    static readonly receipt = z.strictObject({ formatVersion: z.literal(1), installationId: PlatformSchemas.text, installationDirectory: PlatformSchemas.absolute, digest: PlatformSchemas.digest, manifest: this.manifest });
}
type ClosureManifest = z.infer<typeof ClosureSchemas.manifest>;
class ClosureVerifier extends ArtifactResolver {
    metadata(value: Record<string, unknown>): void { this.unsupported(value, true); for (const field of ['dependencies', 'peerDependencies'])
        for (const [name, range] of Object.entries(StrictJson.object(value[field] ?? {})))
            Check.require(PlatformSchemas.packageName.safeParse(name).success && typeof range === 'string' && validRange(range) !== null, 'UNSUPPORTED_DEPENDENCIES'); }
    verify(root: Record<string, unknown>, lock: Record<string, unknown>, packages: Map<string, PackageData>): void { this.lock(root, lock, packages, true); }
    static async inspect(path: string, sha256: string, bytes: Buffer, entry: PackageData['entry']): Promise<PackageData> { const index = await PackageArchiveInspector.inspect(path, sha256), files = new Set<string>(), hashes = new Map<string, string>(), sizes = new Map<string, number>(); for (const file of index.files) {
        files.add(file.path);
        hashes.set(file.path, file.sha256);
        sizes.set(file.path, file.size);
    } Check.require(index.metadata.name === entry.name && index.metadata.version === entry.version, 'SOURCE_CLOSURE_IDENTITY'); return { entry, bytes, metadata: index.metadata, files, hashes, sizes }; }
}
/** One verified immutable artifact closure, separate from source lookup evidence. */
export class SourceClosureStore {
    constructor(private readonly authority: InstallationAuthority) { }
    static yield(done: (value: void) => void): void { setImmediate(done); }
    private directory(name: string, create: boolean): SafeDirectory { const artifacts = this.authority.store.directory('artifacts', this.authority.writer); try {
        if (!artifacts.entries().includes(name)) {
            Check.require(create, 'SOURCE_CLOSURE_MISSING');
            return InstallationStore.mkdir(artifacts, name);
        }
        return artifacts.directory(name, true);
    }
    finally {
        artifacts.close();
    } }
    attempt(record: PluginRequestRecord): SafeDirectory { this.authority.writer.assert(this.authority.store.path); const attempts = this.directory('closure-attempts', true); try {
        const key = CanonicalJson.digest({ requestId: record.requestId, intentDigest: record.intentDigest, policyDigest: record.policyDigest, resolution: record.resolution });
        Check.require(!attempts.entries().includes(key), 'SOURCE_CLOSURE_UNCERTAIN');
        let result: SafeDirectory;
        try {
            result = InstallationStore.mkdir(attempts, key);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST')
                Check.block('SOURCE_CLOSURE_UNCERTAIN');
            throw error;
        }
        try {
            InstallationStore.publish(result, 'intent.json', { formatVersion: 1, installationId: this.authority.plan.configuration.installationId, installationDirectory: this.authority.store.path, requestId: record.requestId, intentDigest: record.intentDigest, policyDigest: record.policyDigest, resolution: record.resolution });
            return result;
        }
        catch (error) {
            result.close();
            throw error;
        }
    }
    finally {
        attempts.close();
    } }
    private static privateFile(directory: SafeDirectory, path: string): void { const stat = lstatSync(directory.childPath(path)); Check.require(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && stat.nlink === 1 && (stat.mode & 0o777) === 0o400, 'SOURCE_CLOSURE_PERMISSIONS'); }
    async read(record: PluginRequestRecord, digest: string): Promise<ClosureManifest> { this.authority.writer.assert(this.authority.store.path); PlatformSchemas.digest.parse(digest); const closures = this.directory('closures', false); try {
        const entry = closures.directory(digest);
        try {
            Check.require(fstatSync(entry.fd).uid === process.getuid?.() && (fstatSync(entry.fd).mode & 0o777) === 0o500 && entry.entries().join(',') === 'archives,bun.lock,package.json,receipt.json', 'SOURCE_CLOSURE_INCOMPLETE');
            SourceClosureStore.privateFile(entry, 'receipt.json');
            const bytes = entry.file('receipt.json', undefined, 4 * 1024 * 1024), parsed = ClosureSchemas.receipt.safeParse(StrictJson.parse(bytes));
            Check.require(parsed.success, 'SOURCE_CLOSURE_INCOMPLETE');
            const receipt = parsed.data, manifest = receipt.manifest;
            Check.require(bytes.toString('utf8') === CanonicalJson.stringify(receipt) + '\n' && receipt.installationId === this.authority.plan.configuration.installationId && receipt.installationDirectory === this.authority.store.path && receipt.digest === digest && CanonicalJson.digest(manifest) === digest, 'SOURCE_CLOSURE_SCOPE');
            Check.require(record.resolution,'SOURCE_CLOSURE_IDENTITY');
            if(record.resolution.kind==='npm')Check.require(manifest.root.name===record.resolution.name&&manifest.root.version===record.resolution.version&&manifest.root.sri===record.resolution.sri,'SOURCE_CLOSURE_IDENTITY');
            else{const archive=await new GitArchiveCache(this.authority,record).fetch();Check.require(manifest.root.name===archive.descriptor.package.name&&manifest.root.version===archive.descriptor.package.version&&manifest.root.sha256===archive.sha256&&manifest.root.sri==='sha256-'+Buffer.from(archive.sha256,'hex').toString('base64'),'SOURCE_CLOSURE_IDENTITY');if(record.sourceReceipt?.kind==='git')Check.require(record.sourceReceipt.tree===archive.tree&&record.sourceReceipt.buildPolicyDigest===null,'SOURCE_CLOSURE_IDENTITY');}
            if (record.sourceReceipt)
                Check.require(record.sourceReceipt.closureDigest === digest && record.sourceReceipt.archiveDigest === manifest.root.sha256, 'SOURCE_CLOSURE_IDENTITY');
            for (const file of [manifest.packageJson, manifest.lockfile])
                SourceClosureStore.privateFile(entry, file.path);
            const root = StrictJson.object(StrictJson.parse(entry.file(manifest.packageJson.path, manifest.packageJson.sha256))), lock = StrictJson.object(StrictJson.parse(entry.file(manifest.lockfile.path, manifest.lockfile.sha256), true)), archives = entry.directory('archives'), packages = new Map<string, PackageData>();
            let total = 0;
            try {
                Check.require(fstatSync(archives.fd).uid === process.getuid?.() && (fstatSync(archives.fd).mode & 0o777) === 0o500 && archives.entries().length === manifest.packages.length, 'SOURCE_CLOSURE_INCOMPLETE');
                for (const file of manifest.packages) {
                    Check.require(!packages.has(file.name) && file.path === 'archives/' + file.sha256 + '.tgz', 'SOURCE_CLOSURE_IDENTITY');
                    SourceClosureStore.privateFile(archives, file.sha256 + '.tgz');
                    const data = entry.file(file.path, file.sha256, 64 * 1024 * 1024);
                    total += data.length;
                    Check.require(total <= 512 * 1024 * 1024, 'SOURCE_CLOSURE_LIMIT');
                    packages.set(file.name, await ClosureVerifier.inspect(join(entry.path, file.path), file.sha256, data, file));
                    await new Promise(SourceClosureStore.yield);
                }
                Check.require(packages.get(manifest.root.name)?.entry.sha256 === manifest.root.sha256, 'SOURCE_CLOSURE_IDENTITY');
                new ClosureVerifier().verify(root, lock, packages);
                archives.verify();
            }
            finally {
                archives.close();
            }
            entry.verify();
            return manifest;
        }
        finally {
            entry.close();
        }
    }
    finally {
        closures.close();
    } }
    async publish(record: PluginRequestRecord, manifest: ClosureManifest, work: SafeDirectory, packages: Map<string, PackageData>): Promise<string> { const digest = CanonicalJson.digest(manifest), closures = this.directory('closures', true); try {
        if (closures.entries().includes(digest)) {
            await this.read(record, digest);
            return digest;
        }
        let entry: SafeDirectory;
        try {
            entry = InstallationStore.mkdir(closures, digest);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST')
                Check.block('SOURCE_CLOSURE_CONFLICT');
            throw error;
        }
        try {
            const archives = InstallationStore.mkdir(entry, 'archives');
            try {
                for (const data of packages.values()) {
                    InstallationStore.publish(archives, data.entry.sha256 + '.tgz', data.bytes, 0o400);
                    await new Promise(SourceClosureStore.yield);
                }
                fchmodSync(archives.fd, 0o500);
                fsyncSync(archives.fd);
            }
            finally {
                archives.close();
            }
            for (const file of [manifest.packageJson, manifest.lockfile])
                InstallationStore.publish(entry, file.path, work.file(file.path, file.sha256), 0o400);
            InstallationStore.publish(entry, 'receipt.json', { formatVersion: 1, installationId: this.authority.plan.configuration.installationId, installationDirectory: this.authority.store.path, digest, manifest }, 0o400);
            fchmodSync(entry.fd, 0o500);
            fsyncSync(entry.fd);
            closures.verify();
            fsyncSync(closures.fd);
            await this.read(record, digest);
            return digest;
        }
        finally {
            entry.close();
        }
    }
    finally {
        closures.close();
    } }
}
/** The standard Bun lock is generated offline, then checked by the existing release verifier. */
export class PackageClosureAcquirer {
    private readonly requests: PluginRequestStore;
    private readonly store: SourceClosureStore;
    constructor(private readonly authority: InstallationAuthority, private readonly source: RootSources) { this.requests = new PluginRequestStore(authority.plan, authority.writer); this.store = new SourceClosureStore(authority); }
    private current(record: PluginRequestRecord): void { this.authority.writer.assert(this.authority.store.path); for (const current of this.requests.records())
        if (current.requestId === record.requestId) {
            Check.require(CanonicalJson.stringify(current) === CanonicalJson.stringify(record), 'SOURCE_REQUEST_CHANGED');
            return;
        } Check.block('PLUGIN_REQUEST_NOT_FOUND'); }
    private base(): ServicePlan { const snapshot = this.authority.store.current(); if (!snapshot)
        return this.authority.plan; const records = this.authority.store.records(); for (let index = records.length - 1; index >= 0; index--) {
        const record = records[index]!;
        if (record.phase === 'completed' && record.desiredComposition === snapshot.compositionGeneration)
            return this.authority.store.read(record.planId, record.digest);
    } return Check.block('INVALID_ACTIVE_COMPOSITION'); }
    private static order(a: PackageData, b: PackageData): number { return a.entry.name < b.entry.name ? -1 : a.entry.name > b.entry.name ? 1 : 0; }
    private static hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
    private async data(path: string, sha256: string, bytes: Buffer, name: string, version: string): Promise<PackageData> { return ClosureVerifier.inspect(path, sha256, bytes, { name, version, path: 'archives/' + sha256 + '.tgz', sha256 }); }
    async acquire(record: PluginRequestRecord): Promise<PluginRequestRecord> { this.current(record); if (record.sourceReceipt) {
        await this.store.read(record, record.sourceReceipt.closureDigest);
        return record;
    } Check.require(record.stage === 'resolved' && record.resolution!==null, 'SOURCE_RESOLUTION_REQUIRED'); const base = this.base(), snapshot = this.authority.store.current(); Check.require(record.expectedGeneration === (snapshot?.compositionGeneration ?? null), 'STALE_GENERATION'); Check.require(CanonicalJson.stringify(base.helpers ?? null) === CanonicalJson.stringify(this.authority.plan.helpers ?? null) && CanonicalJson.stringify(base.acquisitionPolicy ?? null) === CanonicalJson.stringify(this.authority.plan.acquisitionPolicy ?? null), 'SOURCE_POLICY_RESTART_REQUIRED'); const fetched = await this.source.fetch(record), attempt = this.store.attempt(record); let work: SafeDirectory | undefined, release: ManagedReleaseReader | undefined, initial: ManagedReleaseReader | undefined; try {
        work = InstallationStore.mkdir(attempt, 'work');
        const archives = InstallationStore.mkdir(work, 'archives'), packages = new Map<string, PackageData>();
        try {
            release = new ManagedReleaseCache(base).open() ?? undefined;
            initial = new ManagedReleaseCache(this.authority.plan).open() ?? undefined;
            Check.require(release && initial, 'SOURCE_TRUST_UNAVAILABLE');
            const inventory = ServiceSchemas.release.parse(StrictJson.parse(release.read('release.json')));
            Check.require(inventory.packages.length <= 1024, 'SOURCE_CLOSURE_LIMIT');
            const sizes = new Map<string, number>();
            for (const file of release.files)
                sizes.set(file.path, file.size);
            let retainedSize = 0;
            for (const file of inventory.packages) {
                const size = sizes.get(file.path);
                Check.require(size !== undefined && size <= 64 * 1024 * 1024, 'SOURCE_CLOSURE_LIMIT');
                retainedSize += size;
                Check.require(retainedSize <= 512 * 1024 * 1024, 'SOURCE_CLOSURE_LIMIT');
                packages.set(file.name, await this.data(join(release.path, file.path), file.sha256, release.read(file.path), file.name, file.version));
            }
            const rootBytes = this.file(fetched.path, fetched.sha256),rootIdentity=fetched.descriptor.package,rootSri=record.resolution.kind==='npm'?record.resolution.sri:'sha256-'+Buffer.from(fetched.sha256,'hex').toString('base64'), rootData = await this.data(fetched.path, fetched.sha256, rootBytes, rootIdentity.name, rootIdentity.version);
            Check.require(packages.has(rootData.entry.name) || packages.size < 1024, 'SOURCE_CLOSURE_LIMIT');
            packages.set(rootData.entry.name, rootData);
            const queue = [...packages.keys()], visited = new Set<string>(), lookup = new NpmRegistryLookup(this.authority), verifier = new ClosureVerifier();
            let total = 0;
            for (const data of packages.values())
                total += data.bytes.length;
            Check.require(total <= 512 * 1024 * 1024, 'SOURCE_CLOSURE_LIMIT');
            while (queue.length) {
                this.current(record);
                const name = queue.shift()!;
                if (visited.has(name))
                    continue;
                visited.add(name);
                const data = packages.get(name)!;
                verifier.metadata(data.metadata);
                const required = StrictJson.object(data.metadata.dependencies ?? {}), peers = StrictJson.object(data.metadata.peerDependencies ?? {}), optional = StrictJson.object(data.metadata.peerDependenciesMeta ?? {});
                for (const [dependency, range] of Object.entries({ ...peers, ...required })) {
                    Check.require(typeof range === 'string' && validRange(range) !== null, 'UNSUPPORTED_DEPENDENCIES');
                    const existing = packages.get(dependency);
                    if (existing) {
                        Check.require(satisfies(existing.entry.version, range), 'DEPENDENCY_VERSION');
                        queue.push(dependency);
                        continue;
                    }
                    if (!Object.hasOwn(required, dependency) && optional[dependency] !== undefined) {
                        const flag = StrictJson.object(optional[dependency]);
                        Check.require(Object.keys(flag).join(',') === 'optional' && flag.optional === true, 'UNSUPPORTED_DEPENDENCIES');
                        continue;
                    }
                    Check.require(packages.size < 1024, 'SOURCE_CLOSURE_LIMIT');
                    const intent = PluginManagementSchemas.install.parse(record.intent), grant = NpmRegistryLookup.grant(this.authority.plan, dependency, intent.target), directory = InstallationStore.mkdir(work, 'lookup-' + CanonicalJson.digest({ dependency, range }));
                    let resolution;
                    try {
                        resolution = await lookup.read(dependency + '@' + range, grant, record, directory, initial);
                    }
                    finally {
                        directory.close();
                    }
                    const ca = grant.certificateAuthority ? initial.read(grant.certificateAuthority.path) : undefined, raw = await new SourceArchiveCache(this.authority, record, resolution).fetchRuntime(ca), bytes = this.file(raw.path, raw.sha256);
                    total += bytes.length;
                    Check.require(total <= 512 * 1024 * 1024, 'SOURCE_CLOSURE_LIMIT');
                    packages.set(dependency, await this.data(raw.path, raw.sha256, bytes, dependency, resolution.version));
                    queue.push(dependency);
                }
                await new Promise(SourceClosureStore.yield);
            }
            const sorted = [...packages.values()].sort(PackageClosureAcquirer.order), dependencies: Record<string, string> = {};
            for (const data of sorted) {
                InstallationStore.publish(archives, data.entry.sha256 + '.tgz', data.bytes, 0o400);
                dependencies[data.entry.name] = 'file:' + data.entry.path;
            }
            const root = { name: 'cordis-source-closure', version: '1.0.0', private: true, dependencies,overrides:{...dependencies} };
            InstallationStore.publish(work, 'package.json', root);
            const helpers = this.authority.plan.helpers;
            Check.require(helpers, 'SOURCE_HELPER_UNAVAILABLE');
            await new ManagedSourceTools(this.authority.plan, this.authority.writer, helpers.releaseIdentity).run('bun', ['install', '--lockfile-only', '--offline', '--ignore-scripts', '--no-env-file', '--linker=hoisted'], work.path, record);
            const rootFile = work.file('package.json'), lockFile = work.file('bun.lock');
            verifier.verify(StrictJson.object(StrictJson.parse(rootFile)), StrictJson.object(StrictJson.parse(lockFile, true)), packages);
            this.current(record);
            const entries = [];
            for (const data of sorted)
                entries.push(data.entry);
            const manifest = ClosureSchemas.manifest.parse({ formatVersion: 1, baseReleaseDigest: base.releaseDigest, root: { name: rootIdentity.name, version: rootIdentity.version, sha256: fetched.sha256, sri: rootSri }, packageJson: { path: 'package.json', sha256: PackageClosureAcquirer.hash(rootFile) }, lockfile: { path: 'bun.lock', sha256: PackageClosureAcquirer.hash(lockFile) }, packages: entries }), digest = await this.store.publish(record, manifest, work, packages);
            this.current(record);
            const common={locator:(record.intent as {source:string}).source,name:rootIdentity.name,version:rootIdentity.version,archiveDigest:fetched.sha256,sri:rootSri,closureDigest:digest,helperDigests:record.resolution.helperDigests};
            let sourceReceipt;
            if(record.resolution.kind==='npm')sourceReceipt=PluginManagementSchemas.sourceReceipt.parse({...common,kind:'npm',registry:record.resolution.registry});
            else{const archive=await new GitArchiveCache(this.authority,record).fetch();Check.require(archive.sha256===fetched.sha256,'SOURCE_CLOSURE_IDENTITY');sourceReceipt=PluginManagementSchemas.sourceReceipt.parse({...common,kind:'git',origin:record.resolution.origin,commit:record.resolution.commit,tree:archive.tree,buildPolicyDigest:null});}
            return this.requests.append({ ...record, sequence: record.sequence + 1, stage: 'acquired', sourceReceipt });
        }
        finally {
            archives.close();
        }
    }
    finally {
        release?.close();
        initial?.close();
        work?.close();
        attempt.close();
    } }
    private file(path: string, digest: string): Buffer { const slash = path.lastIndexOf('/'), parent = SafeDirectory.open(path.slice(0, slash)); try {
        return parent.file(path.slice(slash + 1), digest, 64 * 1024 * 1024);
    }
    finally {
        parent.close();
    } }
}

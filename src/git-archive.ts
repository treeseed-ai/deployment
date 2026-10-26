import { openSync, closeSync, fstatSync, lstatSync, fchmodSync, fsyncSync, constants, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import { CanonicalJson, PluginManagementSchemas, PlatformSchemas, type PluginRequestRecord, type PluginPackageDescriptor } from '@treeseed-cordis/sdk';
import { InstallationAuthority } from './service-authority.js';
import { InstallationStore } from './installed.js';
import { PluginRequestStore } from './plugin-registry.js';
import { ManagedReleaseCache } from './release-cache.js';
import { ManagedSourceTools } from './managed-tools.js';
import { SourceTrust } from './source-registry.js';
import { PackageArchiveInspector, type PackageArchiveIndex } from './package-archive.js';
import type { ResolvedPackageArchive } from './source-archive.js';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';
export interface RawGitArchive {readonly path:string;readonly sha256:string;readonly size:number;readonly tree:string;readonly descriptor:PluginPackageDescriptor|null;readonly metadata:Readonly<Record<string,unknown>>;}
export interface ResolvedGitArchive extends ResolvedPackageArchive {readonly tree:string;}
type GitResolution = Extract<NonNullable<PluginRequestRecord['resolution']>, {
    kind: 'git';
}>;
/** Held private Git bookkeeping; source repositories never supply local command configuration. */
export class GitRepositoryGuard {
    private readonly fd: number;
    private readonly before: Stats;
    private readonly digest: string;
    constructor(readonly directory: SafeDirectory) {
        this.fd = openSync(directory.childPath('config'), constants.O_RDONLY | constants.O_NOFOLLOW);
        this.before = fstatSync(this.fd);
        try {
            this.digest = createHash('sha256').update(directory.file('config', undefined, 1024 * 1024, true)).digest('hex');
            this.verify();
        }
        catch (error) {
            closeSync(this.fd);
            throw error;
        }
    }
    path(): string { return '/proc/' + process.pid + '/fd/' + this.directory.fd; }
    verify(): void { const after = fstatSync(this.fd), linked = lstatSync(this.directory.childPath('config')); Check.require(after.dev === this.before.dev && after.ino === this.before.ino && after.size === this.before.size && after.mtimeMs === this.before.mtimeMs && after.ctimeMs === this.before.ctimeMs && linked.dev === this.before.dev && linked.ino === this.before.ino, 'GIT_CONFIGURATION_CHANGED'); this.directory.file('config', this.digest, 1024 * 1024, true); this.directory.verify(); }
    close(): void { closeSync(this.fd); this.directory.close(); }
}
class GitArchiveReceipt {
    static readonly schema = z.strictObject({ formatVersion: z.literal(1), installationId: PlatformSchemas.text, installationDirectory: PlatformSchemas.absolute, policyDigest: PlatformSchemas.digest, resolution: PluginManagementSchemas.resolution, tree: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), sha256: PlatformSchemas.digest, size: z.number().int().positive().max(64 * 1024 * 1024), descriptorDigest: PlatformSchemas.digest.nullable() });
}
/** Exact committed bytes only; closure, source builds and activation are separate admission gates. */
export class GitArchiveCache {
    constructor(private readonly authority: InstallationAuthority, private readonly record: PluginRequestRecord) { }
    private authorize(): GitResolution { this.authority.writer.assert(this.authority.store.path); for (const current of new PluginRequestStore(this.authority.plan, this.authority.writer).records())
        if (current.requestId === this.record.requestId) {
            Check.require(CanonicalJson.stringify(current) === CanonicalJson.stringify(this.record) && ['resolved', 'acquired', 'prepared', 'pending', 'active'].includes(current.stage) && current.resolution?.kind === 'git', 'SOURCE_REQUEST_CHANGED');
            return current.resolution;
        } return Check.block('PLUGIN_REQUEST_NOT_FOUND'); }
    private key(resolution: GitResolution): string { return CanonicalJson.digest({ formatVersion: 1, installationId: this.authority.plan.configuration.installationId, installationDirectory: this.authority.store.path, policyDigest: this.record.policyDigest, resolution }); }
    private descriptor(index: PackageArchiveIndex, packages: readonly string[]): PluginPackageDescriptor|null { Check.require(typeof index.metadata.name==='string'&&packages.includes(index.metadata.name),'GIT_PACKAGE_NOT_APPROVED');const parsed = PluginManagementSchemas.packageDescriptor.safeParse(index.metadata.cordisPackage); if(!parsed.success)return null;Check.require(packages.includes(parsed.data.package.name)&&index.metadata.name===parsed.data.package.name&&index.metadata.version===parsed.data.package.version,'INVALID_PLUGIN_PACKAGE'); const files = new Map<string, PackageArchiveIndex['files'][number]>(); for (const file of index.files)
        files.set(file.path, file); for (const provider of parsed.data.providers)
        if(!files.has(provider.entry))return null; for (const asset of parsed.data.assets) {
        const file = files.get(asset.path);
        if(!file)return null;Check.require(file.sha256===asset.sha256&&file.size===asset.size,'INVALID_PLUGIN_PACKAGE');
    } return parsed.data; }
    private static immutableFile(directory: SafeDirectory, name: string): void { const stat = lstatSync(directory.childPath(name)); Check.require(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && stat.nlink === 1 && (stat.mode & 0o777) === 0o400, 'GIT_ARCHIVE_PERMISSIONS'); }
    private async read(directory: SafeDirectory, resolution: GitResolution, packages: readonly string[]): Promise<RawGitArchive> { Check.require((fstatSync(directory.fd).mode & 0o777) === 0o500 && directory.entries().join(',') === 'archive.tgz,receipt.json', 'GIT_ARCHIVE_INCOMPLETE'); GitArchiveCache.immutableFile(directory, 'receipt.json'); const bytes = directory.file('receipt.json', undefined, 4 * 1024 * 1024), parsed = GitArchiveReceipt.schema.safeParse(StrictJson.parse(bytes)); Check.require(parsed.success, 'GIT_ARCHIVE_INCOMPLETE'); const receipt = parsed.data; Check.require(bytes.toString('utf8') === CanonicalJson.stringify(receipt) + '\n' && receipt.installationId === this.authority.plan.configuration.installationId && receipt.installationDirectory === this.authority.store.path && receipt.policyDigest === this.record.policyDigest && CanonicalJson.stringify(receipt.resolution) === CanonicalJson.stringify(resolution), 'GIT_ARCHIVE_SCOPE'); GitArchiveCache.immutableFile(directory, 'archive.tgz'); const archive = directory.file('archive.tgz', receipt.sha256, 64 * 1024 * 1024); Check.require(archive.length === receipt.size, 'GIT_ARCHIVE_INTEGRITY'); const index = await PackageArchiveInspector.inspect(directory.path + '/archive.tgz', receipt.sha256), descriptor = this.descriptor(index, packages); Check.require((descriptor?CanonicalJson.digest(descriptor):null) === receipt.descriptorDigest, 'GIT_ARCHIVE_INTEGRITY'); directory.verify(); this.authorize(); return Object.freeze({ path: directory.path + '/archive.tgz', sha256: receipt.sha256, size: receipt.size, descriptor,tree:receipt.tree,metadata:index.metadata }); }
    private static tree(bytes: Buffer): Map<string, {
        size: number;
        mode: number;
    }> { const files = new Map<string, {
        size: number;
        mode: number;
    }>(); let size = 0; for (const line of new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\0')) {
        if (!line)
            continue;
        const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64}) +([0-9]+)\t(.+)$/.exec(line);
        Check.require(match, 'UNSUPPORTED_GIT_TREE');
        const path = match[4]!, length = Number(match[3]);
        SafeDirectory.relative(path);
        Check.require(!path.split('/').includes('.gitattributes') && !path.split('/').includes('.gitmodules'), 'UNSUPPORTED_GIT_ATTRIBUTES');
        Check.require(!files.has(path) && files.size < 4096 && length <= 8 * 1024 * 1024, 'GIT_TREE_BUDGET');
        size += length;
        Check.require(size <= 64 * 1024 * 1024, 'GIT_TREE_BUDGET');
        files.set(path, { size: length, mode: match[1] === '100755' ? 0o755 : 0o644 });
    } Check.require(files.size > 0, 'INVALID_GIT_TREE'); return files; }
    async fetch():Promise<ResolvedGitArchive>{const raw=await this.source();Check.require(raw.descriptor,'BUILD_REQUIRED');return Object.freeze({path:raw.path,sha256:raw.sha256,size:raw.size,tree:raw.tree,descriptor:raw.descriptor});}
    async source(): Promise<RawGitArchive> {
        const resolution = this.authorize(), policy = this.authority.plan.acquisitionPolicy, intent = PluginManagementSchemas.install.parse(this.record.intent);
        Check.require(policy && this.record.policyDigest === CanonicalJson.digest(policy), 'SOURCE_POLICY_REQUIRED');
        const grants = [];
        for (const grant of policy.git)
            if (grant.origin === resolution.origin && (intent.target ? grant.targets.includes(intent.target) : grant.targets.length === 1))
                grants.push(grant);
        Check.require(grants.length === 1, 'GIT_SOURCE_NOT_APPROVED');
        const grant = grants[0]!, artifacts = this.authority.store.directory('artifacts', this.authority.writer);
        let cache: SafeDirectory | undefined, working: SafeDirectory | undefined, repository: GitRepositoryGuard | undefined, trust: SourceTrust | undefined;
        try {
            cache = artifacts.entries().includes('git-packages') ? artifacts.directory('git-packages', true) : InstallationStore.mkdir(artifacts, 'git-packages');
            for (const name of cache.entries())
                Check.require(/^[a-f0-9]{64}$/.test(name), 'GIT_ARCHIVE_INCOMPLETE');
            const key = this.key(resolution);
            if (cache.entries().includes(key)) {
                const saved = cache.directory(key);
                try {
                    return await this.read(saved, resolution, grant.packages);
                }
                finally {
                    saved.close();
                }
            }
            Check.require(this.record.stage === 'resolved', 'SOURCE_RECEIPT_ARTIFACT_MISSING');
            const saved = InstallationStore.mkdir(cache, key);
            try {
                // A failed exclusive reservation stays incomplete; retries never adopt uncertain work.
                const name = 'git-fetch-' + key;
                Check.require(!artifacts.entries().includes(name), 'GIT_ARCHIVE_INCOMPLETE');
                working = InstallationStore.mkdir(artifacts, name);
                const tools = new ManagedSourceTools(this.authority.plan, this.authority.writer, policy.helperReleaseIdentity), directory = InstallationStore.mkdir(working, 'repository.git');
                try {
                    await tools.run('git', ['--git-dir=/proc/' + process.pid + '/fd/' + directory.fd, 'init', '--bare', '--template=', '--initial-branch=cordis-source', '--shared=0600', '--object-format=' + (resolution.commit.length === 64 ? 'sha256' : 'sha1')], working.path, this.record, true);
                    repository = new GitRepositoryGuard(directory);
                }
                catch (error) {
                    directory.close();
                    throw error;
                }
                const args = ['--git-dir=' + repository.path(), '--no-pager', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'credential.helper=', '-c', 'credential.interactive=false', '-c', 'core.askPass=', '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null', '-c', 'tar.umask=0022', '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true', '-c', 'http.proxy=', '-c', 'http.extraHeader=', '-c', 'gc.auto=0'];
                if (grant.certificateAuthority) {
                    const retained = new ManagedReleaseCache(this.authority.plan).open();
                    Check.require(retained, 'SOURCE_TRUST_UNAVAILABLE');
                    try {
                        trust = new SourceTrust(working, retained.read(grant.certificateAuthority.path), grant.certificateAuthority.sha256);
                        args.push('-c', 'http.sslCAInfo=' + trust.path());
                    }
                    finally {
                        retained.close();
                    }
                }
                await tools.run('git', [...args, 'fetch', '--depth=1', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--', resolution.origin, resolution.commit], working.path, this.record, true);
                trust?.verify();
                repository.verify();
                const identity = (await tools.run('git', [...args, 'rev-parse', '--verify', resolution.commit + '^{commit}'], working.path, this.record, true)).toString('utf8').trim();
                Check.require(identity === resolution.commit, 'GIT_COMMIT_IDENTITY');
                const tree = (await tools.run('git', [...args, 'rev-parse', '--verify', resolution.commit + '^{tree}'], working.path, this.record, true)).toString('utf8').trim();
                Check.require(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree), 'GIT_TREE_IDENTITY');
                const files = GitArchiveCache.tree(await tools.run('git', [...args, 'ls-tree', '-rzl', '--full-tree', resolution.commit], working.path, this.record, true));
                await tools.run('git', [...args, 'archive', '--format=tar', '--prefix=package/', '--output=/proc/' + process.pid + '/fd/' + working.fd + '/archive.tar', resolution.commit], working.path, this.record, true);
                trust?.verify();
                repository.verify();
                const tar = working.file('archive.tar', undefined, 64 * 1024 * 1024), bytes = gzipSync(tar);
                Check.require(bytes.length <= 64 * 1024 * 1024, 'GIT_ARCHIVE_BUDGET');
                const sha256 = createHash('sha256').update(bytes).digest('hex');
                InstallationStore.publish(saved, 'archive.tgz', bytes, 0o400);
                const index = await PackageArchiveInspector.inspect(saved.path + '/archive.tgz', sha256);
                Check.require(index.files.length === files.size, 'GIT_ARCHIVE_TREE');
                for (const file of index.files) {
                    const expected = files.get(file.path);
                    Check.require(expected && expected.size === file.size && expected.mode === file.mode, 'GIT_ARCHIVE_TREE');
                }
                const descriptor = this.descriptor(index, grant.packages);
                this.authorize();
                InstallationStore.publish(saved, 'receipt.json', { formatVersion: 1, installationId: this.authority.plan.configuration.installationId, installationDirectory: this.authority.store.path, policyDigest: this.record.policyDigest, resolution, tree, sha256, size: bytes.length, descriptorDigest: descriptor?CanonicalJson.digest(descriptor):null }, 0o400);
                fchmodSync(saved.fd, 0o500);
                fsyncSync(saved.fd);
                cache.verify();
                fsyncSync(cache.fd);
                return await this.read(saved, resolution, grant.packages);
            }
            finally {
                saved.close();
            }
        }
        finally {
            repository?.close();
            trust?.close();
            working?.close();
            cache?.close();
            artifacts.close();
        }
    }
}

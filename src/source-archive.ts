import { request as httpsRequest } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import { fstatSync, lstatSync, fchmodSync, fsyncSync } from 'node:fs';
import { z } from 'zod';
import { CanonicalJson, PluginSource, PluginManagementSchemas, PlatformSchemas, PlanningBlockedError, type PluginRequestRecord, type PluginPackageDescriptor } from '@treeseed-cordis/sdk';
import { InstallationAuthority } from './service-authority.js';
import { InstallationStore } from './installed.js';
import { PluginRequestStore } from './plugin-registry.js';
import { PackageArchiveInspector, type PackageArchiveIndex } from './package-archive.js';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';
export interface ResolvedPackageArchive {
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
    readonly descriptor: PluginPackageDescriptor;
}
export interface RuntimePackageArchive {readonly path:string;readonly sha256:string;readonly size:number;readonly metadata:Readonly<Record<string,unknown>>;}
interface CachedArchive extends RuntimePackageArchive {readonly descriptor:PluginPackageDescriptor|null;}
type NpmResolution = Extract<NonNullable<PluginRequestRecord['resolution']>, {
    kind: 'npm';
}>;
/** One bounded credential-free HTTPS exchange. Source approval remains the caller's invariant. */
class SourceDownload {
    private request: ClientRequest | undefined;
    private response: IncomingMessage | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private readonly chunks: Buffer[] = [];
    private size = 0;
    private fault = false;
    private done = false;
    private bytes: Buffer | undefined;
    private accept: ((bytes: Buffer) => void) | undefined;
    private reject: ((error: Error) => void) | undefined;
    constructor(private readonly url: string, private readonly ca: Buffer | undefined) { }
    run(): Promise<Buffer> { Check.require(this.url.length <= 4096 && PluginSource.https(this.url), 'SOURCE_ARCHIVE_URL'); return new Promise(this.start.bind(this)); }
    private start(accept: (bytes: Buffer) => void, reject: (error: Error) => void): void { this.accept = accept; this.reject = reject; try {
        this.request = httpsRequest(new URL(this.url), { method: 'GET', agent: false, rejectUnauthorized: true, ca: this.ca, maxHeaderSize: 16384, headers: { accept: 'application/octet-stream', 'accept-encoding': 'identity' } }, this.received.bind(this));
        this.request.once('error', this.failed.bind(this));
        this.request.once('close', this.closed.bind(this));
        this.timer = setTimeout(this.failed.bind(this), 30000);
        this.request.end();
    }
    catch {
        this.failed();
    } }
    private received(response: IncomingMessage): void { this.response = response; const length = response.headers['content-length']; if (this.fault || response.statusCode !== 200 || response.headers['content-encoding'] !== undefined || (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > 64 * 1024 * 1024))) {
        this.failed();
        return;
    } response.on('data', this.data.bind(this)); response.once('error', this.failed.bind(this)); response.once('aborted', this.failed.bind(this)); response.once('end', this.ended.bind(this)); }
    private data(bytes: Buffer): void { if (this.fault || this.done)
        return; this.size += bytes.length; if (this.size > 64 * 1024 * 1024) {
        this.failed();
        return;
    } this.chunks.push(bytes); }
    private ended(): void { const length = this.response?.headers['content-length']; if (this.fault || !this.response?.complete || (length !== undefined && Number(length) !== this.size)) {
        this.failed();
        return;
    } this.bytes = Buffer.concat(this.chunks); this.request!.destroy(); }
    private failed(): void { if (this.done)
        return; this.fault = true; this.response?.destroy(); if (this.request)
        this.request.destroy();
    else
        this.closed(); }
    private closed(): void { if (this.done)
        return; this.done = true; clearTimeout(this.timer); this.response?.destroy(); this.request?.destroy(); if (!this.fault && this.bytes)
        this.accept!(this.bytes);
    else
        this.reject!(new PlanningBlockedError([{ code: 'SOURCE_ARCHIVE_FETCH_FAILED', message: 'The approved source archive could not be fetched.' }])); }
}
class SourceArchiveSchema {
    static readonly receipt = z.strictObject({ formatVersion: z.literal(1), installationId: PlatformSchemas.text, installationDirectory: PlatformSchemas.absolute, resolution: PluginManagementSchemas.resolution, sha256: PlatformSchemas.digest, size: z.number().int().nonnegative().max(64 * 1024 * 1024) });
}
/** Raw-byte custody only. It does not claim complete dependency closure or activation. */
export class SourceArchiveCache {
    constructor(private readonly authority: InstallationAuthority, private readonly record: PluginRequestRecord,private readonly runtime?:NpmResolution) { }
    private authorize(): NpmResolution { this.authority.writer.assert(this.authority.store.path); for (const current of new PluginRequestStore(this.authority.plan, this.authority.writer).records())
        if (current.requestId === this.record.requestId) {
            Check.require(CanonicalJson.stringify(current) === CanonicalJson.stringify(this.record) && ['resolved','acquired','prepared','pending','active'].includes(current.stage) && current.resolution!==null, 'SOURCE_REQUEST_CHANGED');
            if(this.runtime)return this.runtime;Check.require(current.resolution?.kind==='npm','SOURCE_REQUEST_CHANGED');return current.resolution;
        } return Check.block('PLUGIN_REQUEST_NOT_FOUND'); }
    private key(resolution: NpmResolution): string { return CanonicalJson.digest({ formatVersion: 1, installationId: this.authority.plan.configuration.installationId, installationDirectory: this.authority.store.path, resolution }); }
    private directory(create: boolean): SafeDirectory | null { const artifacts = this.authority.store.directory('artifacts', this.authority.writer),name=this.runtime?'runtime-packages':'packages'; try {
        if (!artifacts.entries().includes(name)) {
            if (!create)
                return null;
            const directory = InstallationStore.mkdir(artifacts, name);
            return directory;
        }
        return artifacts.directory(name, true);
    }
    finally {
        artifacts.close();
    } }
    private static file(directory: SafeDirectory, name: string): void { const stat = lstatSync(directory.childPath(name)); Check.require(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && stat.nlink === 1 && (stat.mode & 0o777) === 0o400, 'SOURCE_ARCHIVE_PERMISSIONS'); }
    private declaration(index: PackageArchiveIndex, resolution: NpmResolution): PluginPackageDescriptor|null { Check.require(index.metadata.name === resolution.name && index.metadata.version === resolution.version, 'SOURCE_ARCHIVE_IDENTITY');if(this.runtime)return null;const parsed = PluginManagementSchemas.packageDescriptor.safeParse(index.metadata.cordisPackage); Check.require(parsed.success && parsed.data.package.name === resolution.name && parsed.data.package.version === resolution.version, 'INVALID_PLUGIN_PACKAGE'); const files = new Map<string,PackageArchiveIndex['files'][number]>(); for (const file of index.files)
        files.set(file.path, file); for (const provider of parsed.data.providers)
        Check.require(files.has(provider.entry), 'INVALID_PLUGIN_PACKAGE'); for (const asset of parsed.data.assets) {
        const file = files.get(asset.path);
        Check.require(file && file.sha256 === asset.sha256 && file.size === asset.size, 'INVALID_PLUGIN_PACKAGE');
    } return parsed.data; }
    private sri(bytes: Buffer, resolution: NpmResolution): void { const match = /^(sha256|sha512)-([A-Za-z0-9+/]+=*)$/.exec(resolution.sri); Check.require(match && createHash(match[1]!).update(bytes).digest('base64') === match[2], 'SOURCE_ARCHIVE_INTEGRITY'); }
    private async read(directory: SafeDirectory, resolution: NpmResolution): Promise<CachedArchive> { const stat = fstatSync(directory.fd); Check.require(stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o500 && directory.entries().join(',') === 'archive.tgz,receipt.json', 'SOURCE_ARCHIVE_INCOMPLETE'); SourceArchiveCache.file(directory, 'receipt.json'); const bytes = directory.file('receipt.json', undefined, 4 * 1024 * 1024), parsed=SourceArchiveSchema.receipt.safeParse(StrictJson.parse(bytes));Check.require(parsed.success,'SOURCE_ARCHIVE_INCOMPLETE');const receipt=parsed.data; Check.require(bytes.toString('utf8') === CanonicalJson.stringify(receipt) + '\n' && receipt.installationId === this.authority.plan.configuration.installationId && receipt.installationDirectory === this.authority.store.path && CanonicalJson.stringify(receipt.resolution) === CanonicalJson.stringify(resolution), 'SOURCE_ARCHIVE_SCOPE'); SourceArchiveCache.file(directory, 'archive.tgz'); const archive = directory.file('archive.tgz', receipt.sha256, 64 * 1024 * 1024); Check.require(archive.length === receipt.size, 'SOURCE_ARCHIVE_INTEGRITY'); this.sri(archive, resolution); const index = await PackageArchiveInspector.inspect(directory.path+'/archive.tgz', receipt.sha256), descriptor = this.declaration(index, resolution); directory.verify(); this.authorize(); return Object.freeze({ path: directory.path + '/archive.tgz', sha256: receipt.sha256, size: receipt.size, descriptor,metadata:index.metadata }); }
    private async existing(resolution: NpmResolution): Promise<CachedArchive | null> { const packages = this.directory(false); if (!packages)
        return null; try {
        for (const name of packages.entries())
            Check.require(/^[a-f0-9]{64}$/.test(name), 'SOURCE_ARCHIVE_INCOMPLETE');
        const key = this.key(resolution);
        if (!packages.entries().includes(key))
            return null;
        const directory = packages.directory(key);
        try {
            return await this.read(directory, resolution);
        }
        finally {
            directory.close();
        }
    }
    finally {
        packages.close();
    } }
    async fetch(ca:Buffer|undefined):Promise<ResolvedPackageArchive>{Check.require(!this.runtime,'PLUGIN_ARCHIVE_REQUIRED');const data=await this.raw(ca);Check.require(data.descriptor,'INVALID_PLUGIN_PACKAGE');return Object.freeze({path:data.path,sha256:data.sha256,size:data.size,descriptor:data.descriptor});}
    async fetchRuntime(ca:Buffer|undefined):Promise<RuntimePackageArchive>{Check.require(this.runtime,'RUNTIME_ARCHIVE_REQUIRED');const data=await this.raw(ca);return Object.freeze({path:data.path,sha256:data.sha256,size:data.size,metadata:data.metadata});}
    private async raw(ca: Buffer | undefined): Promise<CachedArchive> {
        const resolution = this.authorize(), existing = await this.existing(resolution);
        if (existing)
            return existing;
        Check.require(this.record.stage==='resolved','SOURCE_RECEIPT_ARTIFACT_MISSING');
        const bytes = await new SourceDownload(resolution.tarball, ca).run();
        this.sri(bytes, resolution);
        this.authorize();
        const sha256 = createHash('sha256').update(bytes).digest('hex'), packages = this.directory(true)!;
        try {
            for (const name of packages.entries())
                Check.require(/^[a-f0-9]{64}$/.test(name), 'SOURCE_ARCHIVE_INCOMPLETE');
            const key = this.key(resolution);
            Check.require(!packages.entries().includes(key), 'SOURCE_ARCHIVE_CONFLICT');
            // Exclusive reservation cannot replace a foreign empty directory in a rename race.
            const directory = InstallationStore.mkdir(packages, key);
            try {
                InstallationStore.publish(directory, 'archive.tgz', bytes, 0o400);
                const index = await PackageArchiveInspector.inspect(directory.path + '/archive.tgz', sha256);
                this.declaration(index, resolution);
                this.authorize();
                InstallationStore.publish(directory, 'receipt.json', { formatVersion: 1, installationId: this.authority.plan.configuration.installationId, installationDirectory: this.authority.store.path, resolution, sha256, size: bytes.length }, 0o400);
                fchmodSync(directory.fd, 0o500);
                fsyncSync(directory.fd);
                packages.verify();
                fsyncSync(packages.fd);
                return await this.read(directory, resolution);
            }
            finally {
                directory.close();
            }
        }
        finally {
            packages.close();
        }
    }
}

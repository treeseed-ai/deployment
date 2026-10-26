import { open, type FileHandle } from 'node:fs/promises';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { openSync, closeSync, readSync, writeFileSync, fstatSync, lstatSync, fchmodSync, chmodSync, fsyncSync, renameSync, constants } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { CanonicalJson, PlatformSchemas, ServiceSchemas, type ServicePlan, type ServiceRelease, type PluginRequestRecord } from '@treeseed-cordis/sdk';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';
import { ServicePlanStore, ServicePlanIdentity } from './service-plan.js';
import { PluginRequestStore } from './plugin-registry.js';
import { InstallationStore, type InstallationWriter } from './installed.js';
import { ServiceArtifactResolver } from './service-artifacts.js';
interface ReleaseFile {
    path: string;
    sha256: string;
    size: number;
    mode: 0o400 | 0o500;
}
class ReleaseFileInventory {
    private readonly files = new Map<string, ReleaseFile>();
    constructor(private readonly root: SafeDirectory, private readonly plan: ServicePlan) { }
    private static digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
    private size(path: string): number {
        const parts = SafeDirectory.relative(path), name = parts.pop()!;
        let parent = this.root;
        try {
            if (parts.length)
                parent = this.root.directory(parts.join('/'));
            const stat = lstatSync(parent.childPath(name));
            Check.require(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'RELEASE_CACHE_SOURCE');
            SafeDirectory.owner(stat, false);
            parent.verify();
            return stat.size;
        }
        finally {
            if (parent !== this.root)
                parent.close();
        }
    }
    private add(path: string, sha256: string, size?: number, mode: 0o400 | 0o500 = 0o400): void { Check.require(PlatformSchemas.relative.safeParse(path).success && PlatformSchemas.digest.safeParse(sha256).success, 'RELEASE_CACHE_SOURCE'); const entry = { path, sha256, size: size ?? this.size(path), mode }, previous = this.files.get(path); Check.require(!previous || CanonicalJson.stringify(previous) === CanonicalJson.stringify(entry), 'RELEASE_CACHE_COLLISION'); this.files.set(path, entry); }
    private descriptor(value: unknown): {
        digest: string;
        size: number;
    } { const data = StrictJson.object(value); Check.require(typeof data.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(data.digest) && Number.isSafeInteger(data.size) && Number(data.size) >= 0, 'RELEASE_CACHE_SOURCE'); return { digest: data.digest.slice(7), size: Number(data.size) }; }
    private image(image: ServiceRelease['images'][number]): void {
        const prefix = image.layout + '/', layout = this.root.file(prefix + 'oci-layout', undefined, 4 * 1024 * 1024);
        Check.require(StrictJson.object(StrictJson.parse(layout)).imageLayoutVersion === '1.0.0', 'RELEASE_CACHE_SOURCE');
        this.add(prefix + 'oci-layout', ReleaseFileInventory.digest(layout), layout.length);
        const indexBytes = this.root.file(prefix + 'index.json', image.indexSha256, 4 * 1024 * 1024), index = StrictJson.object(StrictJson.parse(indexBytes));
        this.add(prefix + 'index.json', image.indexSha256, indexBytes.length);
        Check.require(Array.isArray(index.manifests), 'RELEASE_CACHE_SOURCE');
        let selected: {
            digest: string;
            size: number;
        } | undefined;
        for (const value of index.manifests) {
            const descriptor = this.descriptor(value);
            if (descriptor.digest === image.manifestDigest) {
                Check.require(!selected, 'RELEASE_CACHE_SOURCE');
                selected = descriptor;
            }
        }
        Check.require(selected, 'RELEASE_CACHE_SOURCE');
        const path = prefix + 'blobs/sha256/' + selected.digest, bytes = this.root.file(path, selected.digest, 4 * 1024 * 1024);
        Check.require(bytes.length === selected.size, 'RELEASE_CACHE_SOURCE');
        this.add(path, selected.digest, selected.size);
        const manifest = StrictJson.object(StrictJson.parse(bytes));
        Check.require(Array.isArray(manifest.layers), 'RELEASE_CACHE_SOURCE');
        for (const value of [manifest.config, ...manifest.layers]) {
            const descriptor = this.descriptor(value);
            this.add(prefix + 'blobs/sha256/' + descriptor.digest, descriptor.digest, descriptor.size);
        }
    }
    read(): ReleaseFile[] {
        const bytes = this.root.file('release.json', this.plan.releaseDigest, 4 * 1024 * 1024), release = ServiceSchemas.release.parse(StrictJson.parse(bytes));
        this.add('release.json', this.plan.releaseDigest, bytes.length);
        for (const file of [release.packageJson, release.lockfile, release.recipe])
            this.add(file.path, file.sha256);
        for (const file of release.packages)
            this.add(file.path, file.sha256);
        this.add(release.composition.worker.path, release.composition.worker.sha256, release.composition.worker.size, 0o500);
        for (const helper of release.helpers?.helpers ?? [])
            if (helper.path)
                this.add(helper.path, helper.sha256, helper.size);
        for (const grant of [...release.acquisitionPolicy?.npm ?? [], ...release.acquisitionPolicy?.git ?? []])
            if (grant.certificateAuthority)
                this.add(grant.certificateAuthority.path, grant.certificateAuthority.sha256);
        for (const image of release.images)
            this.image(image);
        Check.require(this.files.size <= 20000, 'RELEASE_CACHE_LIMIT');
        return [...this.files.values()].sort(ReleaseFileInventory.order);
    }
    private static order(a: ReleaseFile, b: ReleaseFile): number { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; }
}
class ReleaseCacheSchema {
    static readonly file = z.strictObject({ path: PlatformSchemas.relative, sha256: PlatformSchemas.digest, size: z.number().int().nonnegative(), mode: z.union([z.literal(0o400), z.literal(0o500)]) });
    static readonly receipt = z.strictObject({ formatVersion: z.literal(1), installationId: PlatformSchemas.text, installationDirectory: PlatformSchemas.absolute, releaseDigest: PlatformSchemas.digest, files: z.array(this.file).min(1).max(20000) });
}
/** Open immutable custody. File consumption verifies bytes; verify() streams the whole bundle. */
export class ManagedReleaseReader {
    readonly path: string;
    readonly files: readonly ReleaseFile[];
    constructor(private readonly root: SafeDirectory, files: ReleaseFile[]) {
        this.path = root.path;
        const retained: ReleaseFile[] = [];
        for (const file of files)
            retained.push(Object.freeze({ ...file }));
        this.files = Object.freeze(retained);
        this.inventory(root, '', new Map(this.files.map(ManagedReleaseReader.entry)));
    }
    private static entry(file: ReleaseFile): [
        string,
        ReleaseFile
    ] { return [file.path, file]; }
    private inventory(directory: SafeDirectory, prefix: string, expected: Map<string, ReleaseFile>): void {
        const stat = fstatSync(directory.fd);
        Check.require(stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o500, 'RELEASE_CACHE_PERMISSIONS');
        for (const name of directory.entries()) {
            const path = prefix + name, stat = lstatSync(directory.childPath(name));
            Check.require(!stat.isSymbolicLink() && stat.uid === process.getuid?.(), 'RELEASE_CACHE_IDENTITY');
            if (stat.isDirectory()) {
                let declared = false;
                for (const key of expected.keys())
                    if (key.startsWith(path + '/'))
                        declared = true;
                Check.require(declared, 'RELEASE_CACHE_INVENTORY');
                const child = directory.directory(name);
                try {
                    this.inventory(child, path + '/', expected);
                }
                finally {
                    child.close();
                }
            }
            else {
                const file = expected.get(path);
                Check.require(file && stat.isFile() && stat.nlink === 1 && stat.size === file.size && (stat.mode & 0o777) === file.mode, 'RELEASE_CACHE_INVENTORY');
                expected.delete(path);
            }
        }
        if (!prefix)
            Check.require(expected.size === 0, 'RELEASE_CACHE_INVENTORY');
        directory.verify();
    }
    private consume(file: ReleaseFile, buffer: boolean): Buffer | undefined {
        const parts = SafeDirectory.relative(file.path), name = parts.pop()!;
        let parent = this.root;
        try {
            if (parts.length)
                parent = this.root.directory(parts.join('/'));
            const before = lstatSync(parent.childPath(name));
            Check.require(fstatSync(this.root.fd).uid === process.getuid?.() && (fstatSync(this.root.fd).mode & 0o777) === 0o500 && (fstatSync(parent.fd).mode & 0o777) === 0o500 && before.isFile() && !before.isSymbolicLink() && before.uid === process.getuid?.() && before.nlink === 1 && before.size === file.size && (before.mode & 0o777) === file.mode, 'RELEASE_CACHE_PERMISSIONS');
            let bytes: Buffer | undefined;
            if (buffer)
                bytes = this.root.file(file.path, file.sha256, 512 * 1024 * 1024);
            else
                this.root.hash(file.path, file.sha256, file.size);
            const after = lstatSync(parent.childPath(name));
            Check.require(after.dev === before.dev && after.ino === before.ino && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && (after.mode & 0o777) === file.mode && (fstatSync(parent.fd).mode & 0o777) === 0o500, 'RELEASE_CACHE_IDENTITY');
            parent.verify();
            return bytes;
        }
        finally {
            if (parent !== this.root)
                parent.close();
        }
    }
    read(path: string): Buffer {
        let selected: ReleaseFile | undefined;
        for (const file of this.files)
            if (file.path === path)
                selected = file;
        Check.require(selected, 'RELEASE_CACHE_PATH');
        const bytes = this.consume(selected, true)!;
        Check.require(bytes.length === selected.size, 'RELEASE_CACHE_IDENTITY');
        return bytes;
    }
    verify(): void {
        this.inventory(this.root, '', new Map(this.files.map(ManagedReleaseReader.entry)));
        for (const file of this.files)
            this.consume(file, false);
        this.root.verify();
    }
    private static yield(done: (value: void) => void): void { setImmediate(done); }
    async verifyAsync(): Promise<void> { this.inventory(this.root, '', new Map(this.files.map(ManagedReleaseReader.entry))); for (const file of this.files) {
        const parts = SafeDirectory.relative(file.path), name = parts.pop()!;
        let parent = this.root;
        let input: FileHandle | undefined;
        try {
            if (parts.length)
                parent = this.root.directory(parts.join('/'));
            input = await open(parent.childPath(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const before = await input.stat();
            Check.require(before.isFile() && before.nlink === 1 && before.uid === process.getuid?.() && before.size === file.size && (before.mode & 0o777) === file.mode, 'RELEASE_CACHE_IDENTITY');
            const buffer = Buffer.alloc(1024 * 1024), hash = createHash('sha256');
            let position = 0;
            while (position < before.size) {
                const read = await input.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
                Check.require(read.bytesRead > 0, 'RELEASE_CACHE_IDENTITY');
                hash.update(buffer.subarray(0, read.bytesRead));
                position += read.bytesRead;
                await new Promise(ManagedReleaseReader.yield);
            }
            const after = await input.stat(), linked = lstatSync(parent.childPath(name));
            Check.require(after.dev === before.dev && after.ino === before.ino && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && (after.mode & 0o777) === file.mode && linked.dev === before.dev && linked.ino === before.ino && hash.digest('hex') === file.sha256, 'RELEASE_CACHE_IDENTITY');
            parent.verify();
        }
        finally {
            await input?.close();
            if (parent !== this.root)
                parent.close();
        }
    } this.root.verify(); }
    close(): void { this.root.close(); }
}
/** Same installation writer, immutable allowlist, no imports or runtime resources. */
export class ManagedReleaseCache {
    private readonly plan: ServicePlan;
    constructor(plan: ServicePlan) { this.plan = ServiceSchemas.plan.parse(plan); const saved = new ServicePlanStore(this.plan.configuration.installationDirectory).read(this.plan.id, this.plan.digest); Check.require(CanonicalJson.stringify(saved) === CanonicalJson.stringify(this.plan), 'PLAN_BINDING'); }
    private authorize(writer: InstallationWriter, request?: PluginRequestRecord): void {
        writer.assert(this.plan.configuration.installationDirectory);
        if (request) {
            let accepted = false;
            for (const record of new PluginRequestStore(this.plan, writer).records())
                if (CanonicalJson.stringify(record) === CanonicalJson.stringify(request) && ['resolving', 'resolved'].includes(record.stage))
                    accepted = true;
            Check.require(accepted, 'ACCEPTED_ACQUISITION_REQUIRED');
            return;
        }
        let accepted = false;
        for (const record of new ServicePlanStore(this.plan.configuration.installationDirectory).records())
            if (record.planId === this.plan.id && record.digest === this.plan.digest && record.phase === 'stage' && record.recovery === null)
                accepted = true;
        Check.require(accepted, 'ACCEPTED_STAGE_REQUIRED');
    }
    open(): ManagedReleaseReader | null {
        const root = SafeDirectory.open(this.plan.configuration.installationDirectory);
        try {
            const state = root.directory('.cordis', true);
            try {
                if (!state.entries().includes('artifacts'))
                    return null;
                const artifacts = state.directory('artifacts', true);
                try {
                    if (!artifacts.entries().includes('releases'))
                        return null;
                    const releases = artifacts.directory('releases', true);
                    try {
                        for (const name of releases.entries())
                            Check.require(/^[a-f0-9]{64}$/.test(name), 'INCOMPLETE_RELEASE_CACHE');
                        if (!releases.entries().includes(this.plan.releaseDigest))
                            return null;
                        const entry = releases.directory(this.plan.releaseDigest);
                        try {
                            const stat = fstatSync(entry.fd);
                            Check.require(stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o500 && entry.entries().join(',') === 'bundle,receipt.json', 'RELEASE_CACHE_INVENTORY');
                            const receiptStat = lstatSync(entry.childPath('receipt.json'));
                            Check.require(receiptStat.isFile() && !receiptStat.isSymbolicLink() && receiptStat.nlink === 1 && receiptStat.uid === process.getuid?.() && (receiptStat.mode & 0o777) === 0o400, 'RELEASE_CACHE_PERMISSIONS');
                            const bytes = entry.file('receipt.json', undefined, 4 * 1024 * 1024), receipt = ReleaseCacheSchema.receipt.parse(StrictJson.parse(bytes));
                            Check.require(bytes.toString('utf8') === CanonicalJson.stringify(receipt) + '\n' && receipt.installationId === this.plan.configuration.installationId && receipt.installationDirectory === this.plan.configuration.installationDirectory && receipt.releaseDigest === this.plan.releaseDigest, 'RELEASE_CACHE_SCOPE');
                            const bundle = entry.directory('bundle');
                            try {
                                const files = new ReleaseFileInventory(bundle, this.plan).read();
                                Check.require(CanonicalJson.stringify(files) === CanonicalJson.stringify(receipt.files), 'RELEASE_CACHE_INVENTORY');
                                return new ManagedReleaseReader(bundle, files);
                            }
                            catch (error) {
                                bundle.close();
                                throw error;
                            }
                        }
                        finally {
                            entry.close();
                        }
                    }
                    finally {
                        releases.close();
                    }
                }
                finally {
                    artifacts.close();
                }
            }
            finally {
                state.close();
            }
        }
        finally {
            root.close();
        }
    }
    private parents(root: SafeDirectory, path: string): {
        directory: SafeDirectory;
        name: string;
    } {
        const parts = SafeDirectory.relative(path), name = parts.pop()!;
        let directory = root;
        try {
            for (const part of parts) {
                const child = directory.entries().includes(part) ? directory.directory(part, true) : InstallationStore.mkdir(directory, part);
                if (directory !== root)
                    directory.close();
                directory = child;
            }
            return { directory, name };
        }
        catch (error) {
            if (directory !== root)
                directory.close();
            throw error;
        }
    }
    private static yield(done: (value: void) => void): void { setImmediate(done); }
    private static async sync(directory: SafeDirectory): Promise<void> { directory.verify(); const handle = await open('/proc/self/fd/' + directory.fd, constants.O_RDONLY | constants.O_DIRECTORY); try {
        await handle.sync();
    }
    finally {
        await handle.close();
    } directory.verify(); }
    private async copy(source: SafeDirectory, target: SafeDirectory, file: ReleaseFile): Promise<void> {
        const parts = SafeDirectory.relative(file.path), name = parts.pop()!;
        let parent = source;
        let destination: ReturnType<ManagedReleaseCache['parents']> | undefined;
        let input: FileHandle | undefined, output: FileHandle | undefined;
        try {
            if (parts.length)
                parent = source.directory(parts.join('/'));
            input = await open(parent.childPath(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const before = await input.stat();
            Check.require(before.isFile() && before.nlink === 1 && before.size === file.size, 'RELEASE_CACHE_SOURCE');
            SafeDirectory.owner(before, false);
            destination = this.parents(target, file.path);
            output = await open(destination.directory.childPath(destination.name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
            let position = 0;
            while (position < before.size) {
                const read = await input.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
                Check.require(read.bytesRead > 0, 'RELEASE_CACHE_SOURCE');
                const bytes = buffer.subarray(0, read.bytesRead);
                hash.update(bytes);
                await output.writeFile(bytes);
                position += read.bytesRead;
                await new Promise(ManagedReleaseCache.yield);
            }
            const after = await input.stat(), linked = lstatSync(parent.childPath(name));
            Check.require(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && linked.dev === before.dev && linked.ino === before.ino && hash.digest('hex') === file.sha256, 'RELEASE_CACHE_SOURCE');
            parent.verify();
            await output.chmod(file.mode);
            await output.sync();
            destination.directory.verify();
            await ManagedReleaseCache.sync(destination.directory);
        }
        finally {
            await output?.close();
            await input?.close();
            if (destination && destination.directory !== target)
                destination.directory.close();
            if (parent !== source)
                parent.close();
        }
    }
    private async immutable(directory: SafeDirectory): Promise<void> { for (const name of directory.entries()) {
        const stat = lstatSync(directory.childPath(name));
        if (stat.isDirectory()) {
            const child = directory.directory(name);
            try {
                await this.immutable(child);
            }
            finally {
                child.close();
            }
        }
    } const handle = await open('/proc/self/fd/' + directory.fd, constants.O_RDONLY | constants.O_DIRECTORY); try {
        await handle.chmod(0o500);
        await handle.sync();
    }
    finally {
        await handle.close();
    } directory.verify(); }
    async stage(writer: InstallationWriter, request?: PluginRequestRecord): Promise<ManagedReleaseReader> {
        this.authorize(writer, request);
        const existing = this.open();
        if (existing) {
            try {
                await existing.verifyAsync();
                return existing;
            }
            catch (error) {
                existing.close();
                throw error;
            }
        }
        const resolved = await new ServiceArtifactResolver().resolve(this.plan.configuration);
        Check.require(resolved.releaseDigest === this.plan.releaseDigest && resolved.recipeDigest === this.plan.recipeDigest && resolved.lockDigest === this.plan.lockDigest && CanonicalJson.stringify(resolved.artifacts) === CanonicalJson.stringify(this.plan.artifacts) && CanonicalJson.stringify(ServicePlanIdentity.graph(resolved.inventory.composition)) === CanonicalJson.stringify(this.plan.composition) && CanonicalJson.stringify(resolved.inventory.helpers ?? null) === CanonicalJson.stringify(this.plan.helpers ?? null) && CanonicalJson.stringify(resolved.inventory.acquisitionPolicy ?? null) === CanonicalJson.stringify(this.plan.acquisitionPolicy ?? null), 'PLAN_BINDING');
        this.authorize(writer, request);
        const source = SafeDirectory.open(this.plan.configuration.release.directory), artifacts = new ServicePlanStore(this.plan.configuration.installationDirectory).directory('artifacts', writer);
        let releases: SafeDirectory | undefined;
        try {
            const files = new ReleaseFileInventory(source, this.plan).read();
            Check.require(Buffer.byteLength(CanonicalJson.stringify(files)) <= 3 * 1024 * 1024, 'RELEASE_CACHE_LIMIT');
            releases = artifacts.entries().includes('releases') ? artifacts.directory('releases', true) : InstallationStore.mkdir(artifacts, 'releases');
            for (const name of releases.entries())
                Check.require(/^[a-f0-9]{64}$/.test(name), 'INCOMPLETE_RELEASE_CACHE');
            const temporary = '.pending-' + randomUUID(), entry = InstallationStore.mkdir(releases, temporary);
            try {
                const bundle = InstallationStore.mkdir(entry, 'bundle');
                try {
                    for (const file of files) {
                        this.authorize(writer, request);
                        await this.copy(source, bundle, file);
                    }
                    await this.immutable(bundle);
                    const verify = new ManagedReleaseReader(bundle, files);
                    await verify.verifyAsync();
                }
                finally {
                    bundle.close();
                }
                InstallationStore.publish(entry, 'receipt.json', { formatVersion: 1, installationId: this.plan.configuration.installationId, installationDirectory: this.plan.configuration.installationDirectory, releaseDigest: this.plan.releaseDigest, files }, 0o400);
                await this.immutable(entry);
                this.authorize(writer, request);
                releases.verify();
                Check.require(!releases.entries().includes(this.plan.releaseDigest), 'RELEASE_CACHE_CONFLICT');
                renameSync(releases.childPath(temporary), releases.childPath(this.plan.releaseDigest));
                fsyncSync(releases.fd);
            }
            finally {
                entry.close();
            }
            const reader = this.open();
            Check.require(reader, 'RELEASE_CACHE_PUBLICATION');
            await reader.verifyAsync();
            return reader;
        }
        finally {
            releases?.close();
            artifacts.close();
            source.close();
        }
    }
}

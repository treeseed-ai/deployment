import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, openSync, closeSync, constants, fstatSync, fsyncSync, readSync, lstatSync, type Stats } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { create as createTar } from 'tar';
import { z } from 'zod';
import { CanonicalJson, PlatformSchemas, ServiceSchemas, type ServicePlan, type ServiceRelease } from '@treeseed-cordis/sdk';
import { InstallationStore, InstallationWriter } from './installed.js';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';
import { ServicePlanStore, ServicePlanIdentity } from './service-plan.js';
import { ServiceArtifactResolver } from './service-artifacts.js';
class DockerCall {
    private child: ChildProcess | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private done = false;
    private chunks: Buffer[] = [];
    private size = 0;
    private accept: ((text: string) => void) | undefined;
    private reject: ((error: Error) => void) | undefined;
    constructor(private readonly args: string[], private readonly timeout: number) { }
    run(): Promise<string> { return new Promise(this.start.bind(this)); }
    private start(accept: (text: string) => void, reject: (error: Error) => void): void { this.accept = accept; this.reject = reject; this.child = spawn('docker', this.args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_CONFIG: process.env.DOCKER_CONFIG } }); this.child.stdout?.on('data', this.data.bind(this)); this.child.stderr?.on('data', this.stderr.bind(this)); this.child.once('error', this.failed.bind(this)); this.child.once('close', this.closed.bind(this)); this.timer = setTimeout(this.failed.bind(this), this.timeout); }
    private data(bytes: Buffer): void { this.size += bytes.length; if (this.size > 16 * 1024 * 1024) {
        this.failed();
        return;
    } this.chunks.push(bytes); }
    private stderr(bytes: Buffer): void { this.size += bytes.length; if (this.size > 16 * 1024 * 1024)
        this.failed(); }
    private closed(code: number | null): void { if (this.done)
        return; if (code !== 0) {
        this.failed();
        return;
    } try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(this.chunks));
        this.done = true;
        clearTimeout(this.timer);
        this.accept!(text.trim());
    }
    catch {
        this.failed();
    } }
    private failed(): void { if (this.done)
        return; this.done = true; clearTimeout(this.timer); this.child?.kill('SIGKILL'); this.reject!(new Error('ENGINE_OPERATION_FAILED')); }
}
export interface ServiceImageCommands {
    run(engine: ServicePlan['expectedEngine'], args: string[], timeout?: number): Promise<string>;
    verify(engine: ServicePlan['expectedEngine']): Promise<void>;
}
export class LocalDockerCommands implements ServiceImageCommands {
    run(engine: ServicePlan['expectedEngine'], args: string[], timeout = 15000): Promise<string> { engine = PlatformSchemas.expectedEngine.parse(engine); return new DockerCall(['--host', engine.endpoint, ...args], timeout).run(); }
    async verify(engine: ServicePlan['expectedEngine']): Promise<void> { engine = PlatformSchemas.expectedEngine.parse(engine); Check.require(!process.env.DOCKER_HOST || process.env.DOCKER_HOST === engine.endpoint, 'REMOTE_ENGINE'); const context = StrictJson.parse(Buffer.from(await new DockerCall(['context', 'inspect', engine.context, '--format', '{{json .Endpoints.docker.Host}}'], 15000).run())); Check.require(context === engine.endpoint, 'ENGINE_IDENTITY_CHANGED'); const info = StrictJson.object(StrictJson.parse(Buffer.from(await this.run(engine, ['info', '--format', '{{json .}}'])))); Check.require(info.ID === engine.daemonId && info.OSType === 'linux' && ['amd64', 'x86_64'].includes(String(info.Architecture)), 'ENGINE_IDENTITY_CHANGED'); }
}
export interface ServiceImageBinding {
    manifestDigest: string;
    configDigest: string;
    dockerId: string;
}
class ImageSchemas {
    static readonly binding = z.strictObject({ formatVersion: z.literal(1), installationId: PlatformSchemas.text, installationDirectory: PlatformSchemas.absolute, expectedEngine: PlatformSchemas.expectedEngine, manifestDigest: PlatformSchemas.digest, configDigest: PlatformSchemas.digest, dockerId: z.string().regex(/^sha256:[a-f0-9]{64}$/), archiveDigest: PlatformSchemas.digest, archiveSize: z.number().int().positive() });
}
interface Descriptor {
    digest: string;
    size: number;
    mediaType?: string;
}
export class ServiceImages {
    private readonly plan: ServicePlan;
    private readonly store: ServicePlanStore;
    constructor(plan: ServicePlan, private readonly commands: ServiceImageCommands = new LocalDockerCommands()) { this.plan = ServiceSchemas.plan.parse(plan); this.store = new ServicePlanStore(this.plan.configuration.installationDirectory); }
    async stage(writer: InstallationWriter): Promise<Record<string, ServiceImageBinding>> { writer.assert(this.store.path); Check.require(CanonicalJson.stringify(this.store.read(this.plan.id, this.plan.digest)) === CanonicalJson.stringify(this.plan), 'PLAN_BINDING'); let accepted = false; for (const record of this.store.records())
        if (record.planId === this.plan.id && record.phase === 'stage')
            accepted = true; Check.require(accepted, 'ACCEPTED_STAGE_REQUIRED'); const resolved = await new ServiceArtifactResolver().resolve(this.plan.configuration); Check.require(resolved.releaseDigest === this.plan.releaseDigest && resolved.lockDigest === this.plan.lockDigest && resolved.recipeDigest === this.plan.recipeDigest && CanonicalJson.stringify(resolved.artifacts) === CanonicalJson.stringify(this.plan.artifacts) && CanonicalJson.stringify(ServicePlanIdentity.graph(resolved.inventory.composition)) === CanonicalJson.stringify(this.plan.composition), 'PLAN_BINDING'); await this.commands.verify(this.plan.expectedEngine); writer.assert(this.store.path); const artifacts = this.store.directory('artifacts', writer); let images: SafeDirectory; try {
        if (artifacts.entries().includes('images')) {
            images = artifacts.directory('images', true);
            Check.require(images.entries().length > 0, 'IMAGE_CACHE_REPAIR_REQUIRED');
        }
        else
            images = InstallationStore.mkdir(artifacts, 'images');
    }
    finally {
        artifacts.close();
    } const bundle = SafeDirectory.open(this.plan.configuration.release.directory); try {
        for (const entry of images.entries()) {
            Check.require(/^[a-f0-9]{64}$/.test(entry), 'IMAGE_CACHE_REPAIR_REQUIRED');
            const cached = images.directory(entry, true);
            try {
                const receipt = ImageSchemas.binding.parse(StrictJson.parse(cached.file('binding.json', undefined, 1024 * 1024, true)));
                Check.require(receipt.manifestDigest === entry, 'IMAGE_CACHE_SCOPE');
                this.binding(cached, { manifestDigest: entry }, { configDigest: receipt.configDigest, manifestDigest: entry });
            }
            finally {
                cached.close();
            }
        }
        const result: Record<string, ServiceImageBinding> = {};
        for (const image of resolved.inventory.images) {
            const artifact = this.artifact(image), source = bundle.directory(image.layout);
            try {
                let target: SafeDirectory;
                if (images.entries().includes(image.manifestDigest)) {
                    target = images.directory(image.manifestDigest, true);
                    try {
                        const binding = this.binding(target, image, artifact);
                        const actual = await this.inspect(artifact);
                        Check.require(actual === binding.dockerId, 'IMAGE_IDENTITY_CHANGED');
                        result[image.id] = { manifestDigest: image.manifestDigest, configDigest: artifact.configDigest, dockerId: actual };
                    }
                    finally {
                        target.close();
                    }
                    continue;
                }
                writer.assert(this.store.path);
                target = InstallationStore.mkdir(images, image.manifestDigest);
                try {
                    const layout = InstallationStore.mkdir(target, 'layout');
                    try {
                        this.copy(source, layout, image, artifact);
                        const fd = openSync(target.childPath('image.tar'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
                        await pipeline(createTar({ cwd: `/proc/self/fd/${layout.fd}`, portable: true }, ['oci-layout', 'index.json', 'blobs']), createWriteStream(target.childPath('image.tar'), { fd, autoClose: true }));
                        layout.verify();
                    }
                    finally {
                        layout.close();
                    }
                    const archive = openSync(target.childPath('image.tar'), constants.O_RDONLY | constants.O_NOFOLLOW);
                    let size = 0;
                    try {
                        const stat = fstatSync(archive);
                        SafeDirectory.owner(stat, true);
                        size = stat.size;
                        fsyncSync(archive);
                    }
                    finally {
                        closeSync(archive);
                    }
                    const pinned = ServiceImages.hashArchive(target);
                    try {
                        const archiveDigest = pinned.digest, before = await this.maybeInspect(artifact);
                        if (before === null) {
                            writer.assert(this.store.path);
                            await this.commands.verify(this.plan.expectedEngine);
                            await this.commands.run(this.plan.expectedEngine, ['image', 'load', '--input', `/proc/${process.pid}/fd/${pinned.fd}`], 180000);
                        }
                        await this.commands.verify(this.plan.expectedEngine);
                        const dockerId = await this.inspect(artifact);
                        ServiceImages.verifyArchive(target, pinned);
                        writer.assert(this.store.path);
                        InstallationStore.publish(target, 'binding.json', ImageSchemas.binding.parse({ formatVersion: 1, installationId: this.plan.configuration.installationId, installationDirectory: this.store.path, expectedEngine: this.plan.expectedEngine, manifestDigest: image.manifestDigest, configDigest: artifact.configDigest, dockerId, archiveDigest, archiveSize: size }));
                        this.binding(target, image, artifact);
                        fsyncSync(images.fd);
                        result[image.id] = { manifestDigest: image.manifestDigest, configDigest: artifact.configDigest, dockerId };
                    }
                    finally {
                        closeSync(pinned.fd);
                    }
                }
                finally {
                    target.close();
                }
            }
            finally {
                source.close();
            }
        }
        await this.commands.verify(this.plan.expectedEngine);
        writer.assert(this.store.path);
        images.verify();
        return result;
    }
    finally {
        bundle.close();
        images.close();
    } }
    private artifact(image: ServiceRelease['images'][number]): Extract<ServicePlan['artifacts'][number], {
        kind: 'image';
    }> { for (const artifact of this.plan.artifacts)
        if (artifact.kind === 'image' && artifact.reference === image.reference && artifact.manifestDigest === image.manifestDigest)
            return artifact; return Check.block('MISSING_IMAGE'); }
    private index(image: Pick<ServiceRelease['images'][number], 'manifestDigest'>, size: number): unknown { return { schemaVersion: 2, manifests: [{ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: 'sha256:' + image.manifestDigest, size, platform: { os: 'linux', architecture: 'amd64' } }] }; }
    private descriptors(manifest: Record<string, unknown>): Descriptor[] { const config = StrictJson.object(manifest.config); Check.require(typeof config.digest === 'string' && typeof config.size === 'number' && Array.isArray(manifest.layers), 'OCI_MANIFEST'); const result = [config as unknown as Descriptor]; for (const value of manifest.layers) {
        const layer = StrictJson.object(value);
        Check.require(typeof layer.digest === 'string' && typeof layer.size === 'number', 'OCI_MANIFEST');
        result.push(layer as unknown as Descriptor);
    } return result; }
    private copy(source: SafeDirectory, target: SafeDirectory, image: ServiceRelease['images'][number], artifact: Extract<ServicePlan['artifacts'][number], {
        kind: 'image';
    }>): void { const bytes = source.file('blobs/sha256/' + image.manifestDigest, image.manifestDigest, 4 * 1024 * 1024), manifest = StrictJson.object(StrictJson.parse(bytes)); InstallationStore.publish(target, 'oci-layout', source.file('oci-layout')); InstallationStore.publish(target, 'index.json', this.index(image, bytes.length)); const blobs = InstallationStore.mkdir(target, 'blobs'), sha = InstallationStore.mkdir(blobs, 'sha256'); blobs.close(); try {
        InstallationStore.publish(sha, image.manifestDigest, bytes);
        for (const descriptor of this.descriptors(manifest)) {
            Check.require(/^sha256:[a-f0-9]{64}$/.test(descriptor.digest), 'OCI_DIGEST');
            const digest = descriptor.digest.slice(7), data = source.file('blobs/sha256/' + digest, digest, 512 * 1024 * 1024);
            Check.require(data.length === descriptor.size, 'OCI_SIZE');
            InstallationStore.publish(sha, digest, data);
        }
        Check.require(StrictJson.object(manifest.config).digest === 'sha256:' + artifact.configDigest, 'IMAGE_IDENTITY_CHANGED');
    }
    finally {
        sha.close();
    } source.verify(); target.verify(); }
    private binding(target: SafeDirectory, image: Pick<ServiceRelease['images'][number], 'manifestDigest'>, artifact: Pick<Extract<ServicePlan['artifacts'][number], {
        kind: 'image';
    }>, 'configDigest' | 'manifestDigest'>): z.infer<typeof ImageSchemas.binding> { Check.require(target.entries().join(',') === 'binding.json,image.tar,layout', 'IMAGE_CACHE_REPAIR_REQUIRED'); const parsed = ImageSchemas.binding.safeParse(StrictJson.parse(target.file('binding.json', undefined, 1024 * 1024, true))); Check.require(parsed.success, 'IMAGE_CACHE_REPAIR_REQUIRED'); const value = parsed.data; Check.require(value.installationId === this.plan.configuration.installationId && value.installationDirectory === this.store.path && CanonicalJson.stringify(value.expectedEngine) === CanonicalJson.stringify(this.plan.expectedEngine) && value.manifestDigest === image.manifestDigest && value.configDigest === artifact.configDigest && [artifact.configDigest, artifact.manifestDigest].includes(value.dockerId.slice(7)), 'IMAGE_CACHE_SCOPE'); target.hash('image.tar', value.archiveDigest, value.archiveSize); const layout = target.directory('layout', true); try {
        Check.require(layout.entries().join(',') === 'blobs,index.json,oci-layout', 'IMAGE_CACHE_REPAIR_REQUIRED');
        const bytes = layout.file('blobs/sha256/' + image.manifestDigest, image.manifestDigest, 4 * 1024 * 1024, true), manifest = StrictJson.object(StrictJson.parse(bytes)), index = StrictJson.parse(layout.file('index.json', undefined, 4 * 1024 * 1024, true));
        Check.require(CanonicalJson.stringify(index) === CanonicalJson.stringify(this.index(image, bytes.length)), 'OCI_SELECTION');
        Check.require(StrictJson.object(StrictJson.parse(layout.file('oci-layout', undefined, 1024, true))).imageLayoutVersion === '1.0.0', 'OCI_LAYOUT');
        const sha = layout.directory('blobs/sha256', true);
        try {
            const names = new Set([image.manifestDigest]);
            for (const descriptor of this.descriptors(manifest)) {
                const digest = descriptor.digest.slice(7);
                names.add(digest);
                sha.hash(digest, digest, descriptor.size);
            }
            Check.require(sha.entries().join(',') === [...names].sort().join(','), 'IMAGE_CACHE_REPAIR_REQUIRED');
        }
        finally {
            sha.close();
        }
    }
    finally {
        layout.close();
    } target.verify(); return value; }
    private static hashArchive(target: SafeDirectory): {
        fd: number;
        digest: string;
        stat: Stats;
    } { const path = target.childPath('image.tar'), hash = createHash('sha256'), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); try {
        const before = fstatSync(fd);
        SafeDirectory.owner(before, true);
        Check.require(before.isFile() && before.nlink === 1, 'IMAGE_ARCHIVE_IDENTITY');
        const buffer = Buffer.alloc(1024 * 1024);
        let position = 0, count = 0;
        while ((count = readSync(fd, buffer, 0, buffer.length, position)) > 0) {
            hash.update(buffer.subarray(0, count));
            position += count;
        }
        const result = { fd, digest: hash.digest('hex'), stat: before };
        Check.require(position === before.size, 'IMAGE_ARCHIVE_IDENTITY');
        this.verifyArchive(target, result);
        return result;
    }
    catch (error) {
        closeSync(fd);
        throw error;
    } }
    private static verifyArchive(target: SafeDirectory, archive: {
        fd: number;
        stat: Stats;
    }): void { const current = fstatSync(archive.fd), linked = lstatSync(target.childPath('image.tar')), before = archive.stat; Check.require(current.dev === before.dev && current.ino === before.ino && current.size === before.size && current.mtimeMs === before.mtimeMs && current.ctimeMs === before.ctimeMs && linked.dev === before.dev && linked.ino === before.ino && !linked.isSymbolicLink(), 'IMAGE_ARCHIVE_IDENTITY'); SafeDirectory.owner(current, true); target.verify(); }
    private async maybeInspect(artifact: Extract<ServicePlan['artifacts'][number], {
        kind: 'image';
    }>): Promise<string | null> { for (const digest of [artifact.manifestDigest, artifact.configDigest]) {
        let text: string;
        try {
            text = await this.commands.run(this.plan.expectedEngine, ['image', 'inspect', 'sha256:' + digest]);
        }
        catch {
            continue;
        }
        const value = StrictJson.parse(Buffer.from(text));
        Check.require(Array.isArray(value) && value.length === 1, 'IMAGE_IDENTITY_CHANGED');
        const metadata = StrictJson.object(value[0]);
        Check.require([artifact.manifestDigest, artifact.configDigest].includes(String(metadata.Id).slice(7)) && metadata.Os === 'linux' && metadata.Architecture === 'amd64', 'IMAGE_IDENTITY_CHANGED');
        return String(metadata.Id);
    } return null; }
    private async inspect(artifact: Extract<ServicePlan['artifacts'][number], {
        kind: 'image';
    }>): Promise<string> { const identity = await this.maybeInspect(artifact); Check.require(identity, 'IMAGE_IDENTITY_CHANGED'); return identity; }
}

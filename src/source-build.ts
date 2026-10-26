import { openSync, closeSync, fstatSync, lstatSync, fchmodSync, fsyncSync, constants, type Stats } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CanonicalJson, CapabilityToken, PluginManagementSchemas, PlatformSchemas, ProviderV4Schemas, ServiceSchemas, SourceAcquisitionSchemas, type PluginRequestRecord, type PluginPackageDescriptor, type ServicePlan, type SourceBuildPolicy } from '@treeseed-cordis/sdk';
import { Context, CordisServiceLocator, type CompositionHandle } from '@treeseed-cordis/sdk/runtime';
import { GitArchiveCache, type RawGitArchive } from './git-archive.js';
import { InstallationAuthority, InstallationAuthorityToken } from './service-authority.js';
import { ServiceApplicationRuntime } from './service-application.js';
import { InstallationStore, PackageArchiveMaterializer } from './installed.js';
import { PluginRequestStore } from './plugin-registry.js';
import { ManagedSourceTools } from './managed-tools.js';
import { LocalDockerCommands, type ServiceImageCommands } from './service-images.js';
import { PackageArchiveInspector, type PackageArchiveIndex } from './package-archive.js';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';
export interface BuiltPluginArchive {
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
    readonly descriptor: PluginPackageDescriptor;
    readonly tree: string;
    readonly buildPolicyDigest: string;
}
interface BuildCommands extends ServiceImageCommands {
    capture(engine: ServicePlan['expectedEngine'], args: string[], timeout: number, maximum: number): Promise<Buffer>;
}
export interface PluginBuildAdapter {
    build(record: PluginRequestRecord): Promise<BuiltPluginArchive>;
}
class BuildAdapterValidation {
    parse(value: unknown): PluginBuildAdapter { Check.require(value !== null && typeof value === 'object' && typeof Reflect.get(value, 'build') === 'function', 'INVALID_BUILD_ADAPTER'); return value as PluginBuildAdapter; }
}
export class PluginBuildToken {
    static readonly instance = new CapabilityToken<PluginBuildAdapter>('source.build', ProviderV4Schemas.version, new BuildAdapterValidation());
}
/** Serialized only from generated class code; no parallel handwritten JavaScript implementation. */
class SandboxBuildDriver {
    static source(): string { return this.toString() + '\n' + this.name + '.run();\n'; }
    static async run(): Promise<void> { const fs = await import('node:fs'), entry = process.argv[2]!, output = process.argv[3]!, environment = { PATH: '/tool', HOME: '/work/home', BUN_INSTALL_CACHE_DIR: '/work/cache', NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_IGNORE_SCRIPTS: 'true', LANG: 'C.UTF-8' }; const compiled = Bun.spawn(['/tool/bun', '--no-env-file', '/input/' + entry], { cwd: '/work', env: environment, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }); if (await compiled.exited !== 0)
        process.exit(3); let current = '/work'; for (const part of output.split('/')) {
        current += '/' + part;
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            process.exit(3);
    } const packed = Bun.spawn(['/tool/bun', '--no-env-file', 'pm', 'pack', '--ignore-scripts', '--filename', '/work/result.tgz'], { cwd: current, env: environment, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }); if (await packed.exited !== 0)
        process.exit(3); const stat = fs.lstatSync('/work/result.tgz'); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024)
        process.exit(3); fs.writeFileSync(1, fs.readFileSync('/work/result.tgz')); }
}
class BuildFile {
    readonly fd: number;
    private readonly stat: Stats;
    constructor(private readonly directory: SafeDirectory, private readonly name: string, private readonly digest: string) { this.fd = openSync(directory.childPath(name), constants.O_RDONLY | constants.O_NOFOLLOW); this.stat = fstatSync(this.fd); try {
        this.verify();
    }
    catch (error) {
        closeSync(this.fd);
        this.directory.close();
        throw error;
    } }
    path(): string { this.verify(); return this.directory.path + '/' + this.name; }
    verify(): void { const now = fstatSync(this.fd), linked = lstatSync(this.directory.childPath(this.name)), before = this.stat; Check.require(now.isFile() && now.uid === process.getuid?.() && now.nlink === 1 && now.dev === before.dev && now.ino === before.ino && now.size === before.size && now.mtimeMs === before.mtimeMs && now.ctimeMs === before.ctimeMs && linked.dev === before.dev && linked.ino === before.ino && (now.mode & 0o777) === 0o500, 'BUILD_INPUT_CHANGED'); this.directory.hash(this.name, this.digest); this.directory.verify(); }
    close(): void { closeSync(this.fd); this.directory.close(); }
}
class BuildInputs {
    private readonly files = new Map<string, {
        stat: Stats;
        digest: string;
    }>();
    constructor(private readonly root: SafeDirectory) { this.seal(root, ''); this.verify(); }
    private seal(directory: SafeDirectory, prefix: string): void { for (const name of directory.entries()) {
        const path = prefix + name, stat = lstatSync(directory.childPath(name));
        Check.require(!stat.isSymbolicLink() && stat.uid === process.getuid?.(), 'BUILD_INPUT_CHANGED');
        if (stat.isDirectory()) {
            const child = directory.directory(name, true);
            try {
                this.seal(child, path + '/');
            }
            finally {
                child.close();
            }
        }
        else {
            Check.require(stat.isFile() && stat.nlink === 1, 'BUILD_INPUT_CHANGED');
            const bytes = directory.file(name, undefined, 8 * 1024 * 1024);
            const fd = openSync(directory.childPath(name), constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                fchmodSync(fd, 0o400);
                this.files.set(path, { stat: fstatSync(fd), digest: createHash('sha256').update(bytes).digest('hex') });
            }
            finally {
                closeSync(fd);
            }
        }
    } fchmodSync(directory.fd, 0o500); fsyncSync(directory.fd); }
    private walk(directory: SafeDirectory, prefix: string, seen: Set<string>): void { Check.require((fstatSync(directory.fd).mode & 0o777) === 0o500, 'BUILD_INPUT_CHANGED'); for (const name of directory.entries()) {
        const path = prefix + name, stat = lstatSync(directory.childPath(name));
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
            const child = directory.directory(name);
            try {
                this.walk(child, path + '/', seen);
            }
            finally {
                child.close();
            }
        }
        else {
            const expected = this.files.get(path);
            Check.require(expected && stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o400 && stat.dev === expected.stat.dev && stat.ino === expected.stat.ino && stat.size === expected.stat.size && stat.mtimeMs === expected.stat.mtimeMs && stat.ctimeMs === expected.stat.ctimeMs, 'BUILD_INPUT_CHANGED');
            directory.file(name, expected.digest, 8 * 1024 * 1024);
            seen.add(path);
        }
    } directory.verify(); }
    verify(): void { const seen = new Set<string>(); this.walk(this.root, '', seen); Check.require(seen.size === this.files.size, 'BUILD_INPUT_CHANGED'); }
}
class BuildReceipt {
    static readonly source = z.strictObject({ archiveDigest: PlatformSchemas.digest, tree: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), resolution: PluginManagementSchemas.resolution });
    static readonly schema = z.strictObject({ formatVersion: z.literal(1), installationId: PlatformSchemas.text, installationDirectory: PlatformSchemas.absolute, expectedEngine: PlatformSchemas.expectedEngine, policy: SourceAcquisitionSchemas.build, source: this.source, sha256: PlatformSchemas.digest, size: z.number().int().positive().max(64 * 1024 * 1024), descriptorDigest: PlatformSchemas.digest });
}
class NativePluginBuilder implements PluginBuildAdapter {
    constructor(private readonly authority: InstallationAuthority, private readonly commands: BuildCommands = new LocalDockerCommands()) { }
    private accepted(input: PluginRequestRecord): PluginRequestRecord { this.authority.writer.assert(this.authority.store.path); for (const record of new PluginRequestStore(this.authority.plan, this.authority.writer).records())
        if (record.requestId === input.requestId) {
            Check.require(CanonicalJson.stringify(record) === CanonicalJson.stringify(input) && record.resolution?.kind === 'git' && ['resolved', 'acquired', 'prepared', 'pending', 'active'].includes(record.stage), 'SOURCE_REQUEST_CHANGED');
            return record;
        } return Check.block('PLUGIN_REQUEST_NOT_FOUND'); }
    private policy(record: PluginRequestRecord): SourceBuildPolicy { const acquisition = this.authority.plan.acquisitionPolicy, intent = PluginManagementSchemas.install.parse(record.intent); Check.require(acquisition && record.policyDigest === CanonicalJson.digest(acquisition) && record.resolution?.kind === 'git', 'SOURCE_POLICY_REQUIRED'); const grants = []; for (const grant of acquisition.git)
        if (grant.origin === record.resolution.origin && (intent.target ? grant.targets.includes(intent.target) : grant.targets.length === 1))
            grants.push(grant); Check.require(grants.length === 1, 'GIT_SOURCE_NOT_APPROVED'); Check.require(grants[0]!.buildPolicyDigest, 'BUILD_REQUIRED'); let selected: SourceBuildPolicy | undefined; for (const candidate of acquisition.builds)
        if (candidate.id === grants[0]!.buildPolicyDigest)
            selected = candidate; Check.require(selected, 'BUILD_REQUIRED'); const { id, ...recipe } = selected; Check.require(id === CanonicalJson.digest(recipe) && selected.origin === record.resolution.origin && selected.commit === record.resolution.commit && selected.helperReleaseIdentity === acquisition.helperReleaseIdentity && selected.network === 'none', 'BUILD_POLICY_IDENTITY'); return selected; }
    private source(raw: RawGitArchive, record: PluginRequestRecord): z.infer<typeof BuildReceipt.source> { return { archiveDigest: raw.sha256, tree: raw.tree, resolution: record.resolution! }; }
    private key(raw: RawGitArchive, record: PluginRequestRecord, policy: SourceBuildPolicy): string { return CanonicalJson.digest({ installationId: this.authority.plan.configuration.installationId, installationDirectory: this.authority.store.path, expectedEngine: this.authority.plan.expectedEngine, policy, source: this.source(raw, record) }); }
    private descriptor(index: PackageArchiveIndex, raw: RawGitArchive): PluginPackageDescriptor { const parsed = PluginManagementSchemas.packageDescriptor.safeParse(index.metadata.cordisPackage); Check.require(parsed.success && index.metadata.name === raw.metadata.name && index.metadata.version === raw.metadata.version && parsed.data.package.name === raw.metadata.name && parsed.data.package.version === raw.metadata.version, 'INVALID_BUILT_PLUGIN'); const files = new Map<string, PackageArchiveIndex['files'][number]>(); for (const file of index.files)
        files.set(file.path, file); for (const provider of parsed.data.providers)
        Check.require(files.has(provider.entry), 'INVALID_BUILT_PLUGIN'); for (const asset of parsed.data.assets) {
        const file = files.get(asset.path);
        Check.require(file && file.sha256 === asset.sha256 && file.size === asset.size, 'INVALID_BUILT_PLUGIN');
    } return parsed.data; }
    private async read(directory: SafeDirectory, raw: RawGitArchive, record: PluginRequestRecord, policy: SourceBuildPolicy): Promise<BuiltPluginArchive> { Check.require((fstatSync(directory.fd).mode & 0o777) === 0o500 && directory.entries().join(',') === 'archive.tgz,receipt.json', 'BUILD_INCOMPLETE'); for (const name of directory.entries()) {
        const stat = lstatSync(directory.childPath(name));
        Check.require(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && stat.nlink === 1 && (stat.mode & 0o777) === 0o400, 'BUILD_PERMISSIONS');
    } const bytes = directory.file('receipt.json', undefined, 4 * 1024 * 1024), parsed = BuildReceipt.schema.safeParse(StrictJson.parse(bytes)); Check.require(parsed.success, 'BUILD_INCOMPLETE'); const receipt = parsed.data; Check.require(bytes.toString('utf8') === CanonicalJson.stringify(receipt) + '\n' && receipt.installationId === this.authority.plan.configuration.installationId && receipt.installationDirectory === this.authority.store.path && CanonicalJson.stringify(receipt.expectedEngine) === CanonicalJson.stringify(this.authority.plan.expectedEngine) && CanonicalJson.stringify(receipt.policy) === CanonicalJson.stringify(policy) && CanonicalJson.stringify(receipt.source) === CanonicalJson.stringify(this.source(raw, record)), 'BUILD_SCOPE'); const archive = directory.file('archive.tgz', receipt.sha256, 64 * 1024 * 1024); Check.require(archive.length === receipt.size, 'BUILD_INTEGRITY'); const index = await PackageArchiveInspector.inspect(directory.path + '/archive.tgz', receipt.sha256), descriptor = this.descriptor(index, raw); Check.require(CanonicalJson.digest(descriptor) === receipt.descriptorDigest, 'BUILD_INTEGRITY'); directory.verify(); this.accepted(record); return Object.freeze({ path: directory.path + '/archive.tgz', sha256: receipt.sha256, size: receipt.size, descriptor, tree: raw.tree, buildPolicyDigest: policy.id }); }
    private async image(policy: SourceBuildPolicy): Promise<string> { await this.commands.verify(this.authority.plan.expectedEngine); const value = StrictJson.parse(Buffer.from(await this.commands.run(this.authority.plan.expectedEngine, ['image', 'inspect', policy.image]))); Check.require(Array.isArray(value) && value.length === 1, 'BUILD_IMAGE_IDENTITY'); const image = StrictJson.object(value[0]), config = StrictJson.object(image.Config); Check.require(image.Os === 'linux' && image.Architecture === 'amd64' && typeof image.Id === 'string' && /^sha256:[a-f0-9]{64}$/.test(image.Id) && Array.isArray(image.RepoDigests) && image.RepoDigests.includes(policy.image) && (!config.Volumes || Object.keys(StrictJson.object(config.Volumes)).length === 0), 'BUILD_IMAGE_IDENTITY'); return image.Id; }
    private async inspectContainer(id: string, key: string, image: string, mounts?: Record<string, string>, isolation = true): Promise<Record<string, unknown>> { Check.require(/^[a-f0-9]{64}$/.test(id), 'BUILD_CONTAINER_IDENTITY'); const data = StrictJson.parse(Buffer.from(await this.commands.run(this.authority.plan.expectedEngine, ['container', 'inspect', id]))); Check.require(Array.isArray(data) && data.length === 1, 'BUILD_CONTAINER_IDENTITY'); const value = StrictJson.object(data[0]), config = StrictJson.object(value.Config), labels = StrictJson.object(config.Labels); Check.require(value.Id === id && value.Image === image && labels['io.treeseed.cordis.build'] === key, 'BUILD_CONTAINER_IDENTITY'); if (!isolation)
        return value; const host = StrictJson.object(value.HostConfig); Check.require(host.ReadonlyRootfs === true && host.NetworkMode === 'none' && host.Privileged === false && host.PidsLimit === 128 && host.Memory === 512 * 1024 * 1024 && host.MemorySwap === 512 * 1024 * 1024 && host.NanoCpus === 1000000000 && Array.isArray(host.CapDrop) && host.CapDrop.includes('ALL') && (!host.CapAdd || (Array.isArray(host.CapAdd) && host.CapAdd.length === 0)) && Array.isArray(host.SecurityOpt) && host.SecurityOpt.includes('no-new-privileges') && config.User === String(process.getuid!()) + ':' + String(process.getgid!()), 'BUILD_ISOLATION_REQUIRED'); if (mounts) {
        Check.require(Array.isArray(value.Mounts) && value.Mounts.length === Object.keys(mounts).length, 'BUILD_ISOLATION_REQUIRED');
        const seen = new Set<string>();
        for (const raw of value.Mounts) {
            const mount = StrictJson.object(raw);
            Check.require(mount.Type === 'bind' && mount.RW === false && typeof mount.Destination === 'string' && !seen.has(mount.Destination) && mounts[mount.Destination] === mount.Source, 'BUILD_ISOLATION_REQUIRED');
            seen.add(mount.Destination);
        }
    } return value; }
    async build(input: PluginRequestRecord): Promise<BuiltPluginArchive> {
        const record = this.accepted(input), policy = this.policy(record), raw = await new GitArchiveCache(this.authority, record).source(), artifacts = this.authority.store.directory('artifacts', this.authority.writer);
        let cache: SafeDirectory | undefined, work: SafeDirectory | undefined, source: SafeDirectory | undefined, helper: BuildFile | undefined, driver: BuildFile | undefined, id: string | undefined, image: string | undefined, key = '', mounts: Record<string, string> | undefined;
        try {
            cache = artifacts.entries().includes('builds') ? artifacts.directory('builds', true) : InstallationStore.mkdir(artifacts, 'builds');
            for (const name of cache.entries())
                Check.require(/^[a-f0-9]{64}$/.test(name), 'BUILD_INCOMPLETE');
            key = this.key(raw, record, policy);
            if (cache.entries().includes(key)) {
                const existing = cache.directory(key);
                try {
                    return await this.read(existing, raw, record, policy);
                }
                finally {
                    existing.close();
                }
            }
            Check.require(record.stage === 'resolved', 'BUILD_ARTIFACT_MISSING');
            const entry = InstallationStore.mkdir(cache, key);
            try {
                const index = await PackageArchiveInspector.inspect(raw.path, raw.sha256);
                let sourceEntry;
                for (const file of index.files)
                    if (file.path === policy.entry)
                        sourceEntry = file;
                Check.require(sourceEntry?.sha256 === policy.entryDigest, 'BUILD_ENTRY_IDENTITY');
                image = await this.image(policy);
                work = InstallationStore.mkdir(artifacts, 'build-work-' + key);
                InstallationStore.publish(work, 'intent.json', { formatVersion: 1, key, recordId: record.requestId, policy, source: this.source(raw, record), image });
                source = InstallationStore.mkdir(work, 'input');
                await PackageArchiveMaterializer.materializePrivate(raw.path, raw.sha256, source.path);
                const inputs = new BuildInputs(source), tools = new ManagedSourceTools(this.authority.plan, this.authority.writer, policy.helperReleaseIdentity), path = await tools.path('bun', record);
                let definition;
                for (const candidate of this.authority.plan.helpers!.helpers)
                    if (candidate.id === 'bun')
                        definition = candidate;
                Check.require(definition && definition.libraryDirectories.length === 0, 'SOURCE_BUILD_HELPER_FORMAT');
                let executable;
                for (const file of definition.files)
                    if (file.path === definition.entry)
                        executable = file;
                Check.require(executable, 'SOURCE_BUILD_HELPER_FORMAT');
                helper = new BuildFile(SafeDirectory.open(dirname(path)), basename(path), executable.sha256);
                const code = Buffer.from(SandboxBuildDriver.source());
                InstallationStore.publish(work, 'driver.ts', code, 0o500);
                driver = new BuildFile(SafeDirectory.open(work.path), 'driver.ts', createHash('sha256').update(code).digest('hex'));
                const uid = process.getuid?.();
                Check.require(uid !== undefined && uid > 0, 'BUILD_NONROOT_REQUIRED');
                mounts = { '/input': source.path, '/tool/bun': helper.path(), '/driver.ts': driver.path() };
                const engine = this.authority.plan.expectedEngine, args = ['container', 'create', '--name', 'cordis-build-' + key.slice(0, 40), '--pull=never', '--network=none', '--read-only', '--user', String(uid) + ':' + String(process.getgid!()), '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=512m', '--memory-swap=512m', '--cpus=1', '--no-healthcheck', '--log-driver=none', '--tmpfs', '/work:rw,nosuid,nodev,size=256m,mode=0700,uid=' + uid + ',gid=' + process.getgid!(), '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777', '--mount', 'type=bind,source=' + source.path + ',target=/input,readonly,bind-recursive=disabled', '--mount', 'type=bind,source=' + helper.path() + ',target=/tool/bun,readonly', '--mount', 'type=bind,source=' + driver.path() + ',target=/driver.ts,readonly', '--label', 'io.treeseed.cordis.build=' + key, '--entrypoint', '/tool/bun', policy.image, '--no-env-file', '/driver.ts', policy.entry, policy.packageDirectory];
                inputs.verify();
                helper.verify();
                driver.verify();
                this.accepted(record);
                id = await this.commands.run(engine, args);
                await this.inspectContainer(id, key, image, mounts);
                InstallationStore.publish(work, 'container.json', { id, key, image });
                const bytes = await this.commands.capture(engine, ['container', 'start', '--attach', id], policy.timeoutMs, 64 * 1024 * 1024), observed = await this.inspectContainer(id, key, image, mounts), state = StrictJson.object(observed.State);
                Check.require(state.Running === false && state.ExitCode === 0, 'BUILD_FAILED');
                inputs.verify();
                helper.verify();
                driver.verify();
                this.accepted(record);
                await this.commands.run(engine, ['container', 'rm', id]);
                id = undefined;
                const remaining = await this.commands.run(engine, ['container', 'ls', '--all', '--quiet', '--filter', 'label=io.treeseed.cordis.build=' + key]);
                Check.require(remaining === '', 'BUILD_CLEANUP_REQUIRED');
                const sha256 = createHash('sha256').update(bytes).digest('hex');
                InstallationStore.publish(entry, 'archive.tgz', bytes, 0o400);
                const built = await PackageArchiveInspector.inspect(entry.path + '/archive.tgz', sha256), descriptor = this.descriptor(built, raw);
                InstallationStore.publish(entry, 'receipt.json', { formatVersion: 1, installationId: this.authority.plan.configuration.installationId, installationDirectory: this.authority.store.path, expectedEngine: engine, policy, source: this.source(raw, record), sha256, size: bytes.length, descriptorDigest: CanonicalJson.digest(descriptor) }, 0o400);
                fchmodSync(entry.fd, 0o500);
                fsyncSync(entry.fd);
                cache.verify();
                fsyncSync(cache.fd);
                return await this.read(entry, raw, record, policy);
            }
            finally {
                entry.close();
            }
        }
        finally {
            try {
                if (id && image) {
                    await this.inspectContainer(id, key, image, undefined, false);
                    await this.commands.run(this.authority.plan.expectedEngine, ['container', 'rm', '--force', id]);
                    Check.require(await this.commands.run(this.authority.plan.expectedEngine, ['container', 'ls', '--all', '--quiet', '--filter', 'id=' + id]) === '', 'BUILD_CLEANUP_REQUIRED');
                }
            }
            finally {
                driver?.close();
                helper?.close();
                source?.close();
                work?.close();
                cache?.close();
                artifacts.close();
            }
        }
    }
}
export class PluginBuildPlugin {
    static readonly provide = [PluginBuildToken.instance.id];
    static readonly inject = [InstallationAuthorityToken.instance.id];
    static readonly Config = ServiceSchemas.plan;
    static readonly declaration = ProviderV4Schemas.declaration.parse({ id: 'deployment.plugin-build', pluginId: 'deployment', capability: PluginBuildToken.instance.id, contractVersion: ProviderV4Schemas.version, target: 'deployment', provide: this.provide, inject: this.inject });
    constructor(context: Context, plan: ServicePlan) { const authority = InstallationAuthorityToken.instance.parse(Reflect.get(context, InstallationAuthorityToken.instance.id)); Check.require(CanonicalJson.stringify(authority.plan) === CanonicalJson.stringify(ServiceSchemas.plan.parse(plan)), 'PLAN_BINDING'); context.provide(PluginBuildToken.instance.id, new NativePluginBuilder(authority)); }
}
export class PluginBuildRuntime extends ServiceApplicationRuntime implements PluginBuildAdapter {
    private buildClosed = false;
    private constructor(handle: CompositionHandle, context: Context) { super(handle, context); }
    static async start(input: ServicePlan): Promise<PluginBuildRuntime> { const plan = ServiceSchemas.plan.parse(input), artifact = { kind: 'bundled' as const, identity: 'deployment-plugin-build.1:' + plan.composition.worker.sha256 }, scope = await this.mount(plan, [{ token: PluginBuildToken.instance, plugin: PluginBuildPlugin, declaration: PluginBuildPlugin.declaration, configuration: plan, artifact }]); return new PluginBuildRuntime(scope.handle, scope.context); }
    async build(record: PluginRequestRecord): Promise<BuiltPluginArchive> { Check.require(!this.buildClosed, 'HOST_CLOSED'); const lease = await CordisServiceLocator.from(this.context).acquire(PluginBuildToken.instance); try {
        return await lease.value.build(record);
    }
    finally {
        await lease.release();
    } }
    async close(timeout = 10000): Promise<void> { this.buildClosed = true; await super.close(timeout); }
}

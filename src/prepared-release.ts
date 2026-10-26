import { createHash } from 'node:crypto';
import { fstatSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CanonicalJson, PlatformSchemas, PluginManagementSchemas, ServiceSchemas, type DeploymentRecipe, type PluginRequestRecord, type ServiceGraph, type ServicePlan, type ServiceRelease } from '@treeseed-cordis/sdk';
import { InstallationAuthority } from './service-authority.js';
import { InstallationStore } from './installed.js';
import { PluginRequestStore } from './plugin-registry.js';
import { SourceClosureStore } from './source-closure.js';
import { ManagedReleaseCache } from './release-cache.js';
import { ServiceArtifactResolver } from './service-artifacts.js';
import { ServicePlanIdentity } from './service-plan.js';
import { PackageArchiveInspector } from './package-archive.js';
import { ArtifactTree, type ArtifactFile } from './artifact-tree.js';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';

class PreparedSchemas {
    static readonly file = z.strictObject({ path: PlatformSchemas.relative, sha256: PlatformSchemas.digest, size: z.number().int().nonnegative(), mode: z.union([z.literal(0o400), z.literal(0o500)]) });
    static readonly receipt = z.strictObject({ formatVersion: z.literal(1), installationId: PlatformSchemas.text, installationDirectory: PlatformSchemas.absolute, requestId: PluginManagementSchemas.key, intentDigest: PlatformSchemas.digest, sourceReceipt: PluginManagementSchemas.sourceReceipt, baseReleaseDigest: PlatformSchemas.digest, compositionDigest: PlatformSchemas.digest, configuration: ServiceSchemas.configuration, files: z.array(this.file).min(1).max(20000) });
}
/** Build only from verified private custody. No import, network, credential or runtime effect. */
export class PreparedServiceRelease {
    constructor(private readonly authority: InstallationAuthority) { }
    private static hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
    private current(record: PluginRequestRecord): void {
        this.authority.writer.assert(this.authority.store.path);
        for (const saved of new PluginRequestStore(this.authority.plan, this.authority.writer).records())
            if (saved.requestId === record.requestId) { Check.require(CanonicalJson.stringify(saved) === CanonicalJson.stringify(record) && record.sourceReceipt !== null, 'SOURCE_REQUEST_CHANGED'); return; }
        Check.block('PLUGIN_REQUEST_NOT_FOUND');
    }
    private base(): ServicePlan {
        const current = this.authority.store.current();
        if (!current) return this.authority.plan;
        const records = this.authority.store.records();
        for (let i = records.length - 1; i >= 0; i--) { const record = records[i]!; if (record.phase === 'completed' && record.desiredComposition === current.compositionGeneration) return this.authority.store.read(record.planId, record.digest); }
        return Check.block('INVALID_ACTIVE_COMPOSITION');
    }
    private root(): SafeDirectory {
        const artifacts = this.authority.store.directory('artifacts', this.authority.writer);
        try { return artifacts.entries().includes('prepared') ? artifacts.directory('prepared', true) : InstallationStore.mkdir(artifacts, 'prepared'); }
        finally { artifacts.close(); }
    }
    private static resource(serviceId: string, slot: string): string { return 'r-' + CanonicalJson.digest({ serviceId, slot }).slice(0, 48); }
    private static recipe(graph: ServiceGraph, inventory: ServiceRelease): { recipe: DeploymentRecipe; references: string[] } {
        const recipe: DeploymentRecipe = { services: {}, volumes: {}, secrets: {} }, references: string[] = [], bindings = new Map<string, string>();
        for (const service of graph.services) for (const binding of service.bindings) bindings.set(binding.bindingId, service.serviceId);
        for (const service of graph.services) {
            let image: ServiceRelease['images'][number] | undefined;
            for (const candidate of inventory.images) if (candidate.id === service.definition.imageId) image = candidate;
            Check.require(image, 'MISSING_IMAGE');
            const spec: DeploymentRecipe['services'][string] = { image: image.reference }, dependencies = new Set<string>();
            for (const dependency of service.dependencies) { const source = bindings.get(dependency.bindingId); Check.require(source, 'SERVICE_BINDING_MISMATCH'); dependencies.add(source); }
            if (dependencies.size) spec.depends_on = [...dependencies].sort();
            for (const port of service.definition.ports) if (port.publication) { spec.ports ??= []; spec.ports.push({ target: port.target, published: port.publication.port, host_ip: port.publication.host, protocol: 'tcp' }); }
            for (const slot of service.resources.volumes) recipe.volumes[this.resource(service.serviceId, slot)] = {};
            if (service.definition.volumes.length) { spec.volumes = []; for (const mount of service.definition.volumes) spec.volumes.push({ type: 'volume', source: this.resource(service.serviceId, mount.source), target: mount.target, read_only: mount.readOnly }); }
            for (const slot of Object.keys(service.resources.slots)) { recipe.secrets[this.resource(service.serviceId, slot)] = { file: '.cordis/credentials/' + service.serviceId + '/' + slot }; references.push('secret://' + service.serviceId + '/' + slot); }
            if (service.definition.secrets.length) { spec.secrets = []; for (const secret of service.definition.secrets) spec.secrets.push(this.resource(service.serviceId, secret.slot)); }
            recipe.services[service.serviceId] = spec;
        }
        return { recipe, references: references.sort() };
    }
    private static file(directory: SafeDirectory, name: string, bytes: Buffer, files: ArtifactFile[]): void { InstallationStore.publish(directory, name, bytes, 0o400); files.push({ path: name, sha256: this.hash(bytes), size: bytes.length, mode: 0o400 }); }
    private async read(entry: SafeDirectory, record: PluginRequestRecord, base: ServicePlan, graph: ServiceGraph): Promise<ServicePlan['configuration']> {
        const stat = fstatSync(entry.fd);
        Check.require(stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o500 && entry.entries().join(',') === 'bundle,receipt.json', 'PREPARED_RELEASE_INCOMPLETE');
        const receiptStat = lstatSync(entry.childPath('receipt.json'));
        Check.require(receiptStat.isFile() && receiptStat.nlink === 1 && receiptStat.uid === process.getuid?.() && (receiptStat.mode & 0o777) === 0o400, 'PREPARED_RELEASE_INCOMPLETE');
        const bytes = entry.file('receipt.json'), parsed = PreparedSchemas.receipt.safeParse(StrictJson.parse(bytes));
        Check.require(parsed.success, 'PREPARED_RELEASE_INCOMPLETE');
        const receipt = parsed.data;
        Check.require(bytes.toString('utf8') === CanonicalJson.stringify(receipt) + '\n' && receipt.installationId === record.installationId && receipt.installationDirectory === this.authority.store.path && receipt.requestId === record.requestId && receipt.intentDigest === record.intentDigest && CanonicalJson.stringify(receipt.sourceReceipt) === CanonicalJson.stringify(record.sourceReceipt) && receipt.baseReleaseDigest === base.releaseDigest && receipt.compositionDigest === CanonicalJson.digest(graph) && receipt.configuration.release.directory === join(entry.path, 'bundle'), 'PREPARED_RELEASE_SCOPE');
        const bundle = entry.directory('bundle');
        try { await ArtifactTree.verify(bundle, receipt.files); }
        finally { bundle.close(); }
        const resolved = await new ServiceArtifactResolver().resolve(receipt.configuration);
        Check.require(CanonicalJson.stringify(resolved.inventory.composition) === CanonicalJson.stringify(graph), 'PREPARED_RELEASE_SCOPE');
        entry.verify(); return receipt.configuration;
    }
    async prepare(input: PluginRequestRecord, composition: ServiceGraph): Promise<ServicePlan['configuration']> {
        const record = structuredClone(input); this.current(record);
        const graph = ServicePlanIdentity.graph(ServiceSchemas.graph.parse(composition)), base = this.base();
        Check.require(record.expectedGeneration === (this.authority.store.current()?.compositionGeneration ?? null), 'STALE_GENERATION');
        Check.require(CanonicalJson.stringify(graph.profile) === CanonicalJson.stringify(base.composition.profile) && CanonicalJson.stringify(graph.worker) === CanonicalJson.stringify(base.composition.worker) && graph.assetDigest === base.composition.assetDigest, 'ROOT_TRANSITION_REQUIRED');
        const manifest = await new SourceClosureStore(this.authority).read(record, record.sourceReceipt!.closureDigest);
        Check.require(manifest.baseReleaseDigest === base.releaseDigest, 'STALE_SOURCE_CLOSURE');
        const key = CanonicalJson.digest({ requestId: record.requestId, intentDigest: record.intentDigest, sourceReceipt: record.sourceReceipt, baseReleaseDigest: base.releaseDigest, composition: graph }), root = this.root();
        let entry: SafeDirectory | undefined;
        try {
            if (root.entries().includes(key)) { entry = root.directory(key); return await this.read(entry, record, base, graph); }
            try { entry = InstallationStore.mkdir(root, key); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') Check.block('PREPARED_RELEASE_CONFLICT'); throw error; }
            const bundle = InstallationStore.mkdir(entry, 'bundle');
            let closure: SafeDirectory | undefined, release: ReturnType<ManagedReleaseCache['open']> = null;
            try {
                closure = SafeDirectory.open(join(this.authority.store.path, '.cordis/artifacts/closures', record.sourceReceipt!.closureDigest));
                release = new ManagedReleaseCache(base).open();
                Check.require(release, 'RELEASE_CACHE_MISSING');
                const inventory = ServiceSchemas.release.parse(StrictJson.parse(release.read('release.json'))), old = new Set([inventory.packageJson.path, inventory.lockfile.path, inventory.recipe.path, 'release.json']);
                for (const file of inventory.packages) old.add(file.path);
                const files: ArtifactFile[] = [], source = SafeDirectory.open(release.path);
                try { for (const file of release.files) if (!old.has(file.path)) { await ArtifactTree.copy(source, bundle, file); files.push({ ...file }); } }
                finally { source.close(); }
                const archives = bundle.entries().includes('archives') ? bundle.directory('archives', true) : InstallationStore.mkdir(bundle, 'archives');
                try { for (const file of manifest.packages) { const bytes = closure.file(file.path, file.sha256, 64 * 1024 * 1024); InstallationStore.publish(archives, file.sha256 + '.tgz', bytes, 0o400); files.push({ path: file.path, sha256: file.sha256, size: bytes.length, mode: 0o400 }); } }
                finally { archives.close(); }
                const rootBytes = closure.file(manifest.packageJson.path, manifest.packageJson.sha256), lockBytes = closure.file(manifest.lockfile.path, manifest.lockfile.sha256);
                PreparedServiceRelease.file(bundle, 'package.json', rootBytes, files); PreparedServiceRelease.file(bundle, 'bun.lock', lockBytes, files);
                const rootPackage = manifest.packages.find(PreparedServiceRelease.named.bind(null, manifest.root.name))!;
                const descriptor = PluginManagementSchemas.packageDescriptor.parse((await PackageArchiveInspector.inspect(join(closure.path, rootPackage.path), rootPackage.sha256)).metadata.cordisPackage);
                const configuration = structuredClone(base.configuration), selected = [];
                for (const plugin of configuration.plugins) if (plugin.id !== descriptor.pluginId && plugin.package !== descriptor.package.name) selected.push(plugin);
                selected.push({ id: descriptor.pluginId, package: descriptor.package.name, version: descriptor.package.version, integrity: rootPackage.sha256 }); configuration.plugins = selected;
                const projection = PreparedServiceRelease.recipe(graph, inventory), recipeBytes = Buffer.from(CanonicalJson.stringify(projection.recipe) + '\n');
                configuration.credentialReferences = projection.references;
                PreparedServiceRelease.file(bundle, 'compose.json', recipeBytes, files);
                inventory.packageJson = { path: 'package.json', sha256: PreparedServiceRelease.hash(rootBytes) }; inventory.lockfile = { path: 'bun.lock', sha256: PreparedServiceRelease.hash(lockBytes) }; inventory.recipe = { path: 'compose.json', sha256: PreparedServiceRelease.hash(recipeBytes) }; inventory.packages = manifest.packages; inventory.composition = graph;
                const releaseBytes = Buffer.from(CanonicalJson.stringify(inventory) + '\n'); PreparedServiceRelease.file(bundle, 'release.json', releaseBytes, files);
                configuration.release = { directory: bundle.path, manifestDigest: PreparedServiceRelease.hash(releaseBytes) };
                await new ServiceArtifactResolver().resolve(configuration); this.current(record);
                await ArtifactTree.seal(bundle);
                files.sort(PreparedServiceRelease.order);
                InstallationStore.publish(entry, 'receipt.json', PreparedSchemas.receipt.parse({ formatVersion: 1, installationId: record.installationId, installationDirectory: this.authority.store.path, requestId: record.requestId, intentDigest: record.intentDigest, sourceReceipt: record.sourceReceipt, baseReleaseDigest: base.releaseDigest, compositionDigest: CanonicalJson.digest(graph), configuration, files }), 0o400);
                await ArtifactTree.seal(entry);
            } finally { bundle.close(); closure?.close(); release?.close(); }
            return await this.read(entry, record, base, graph);
        } finally { entry?.close(); root.close(); }
    }
    private static named(name: string, value: { name: string }): boolean { return name === value.name; }
    private static order(a: ArtifactFile, b: ArtifactFile): number { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; }
}

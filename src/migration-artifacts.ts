import { CanonicalJson, ProviderSchemas, type InstalledPlan } from '@treeseed-cordis/sdk';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';
/** Historical data validation only: never imports providers, extracts archives or reopens the bundle. */
export class MigrationArtifacts {
    static verify(plan: InstalledPlan, state: SafeDirectory, files: ReadonlyArray<{
        path: string;
        kind: string;
        mode: number;
        size: number;
        sha256: string | null;
    }>): void { const inventory = new Map<string, typeof files[number]>(); for (const file of files)
        inventory.set(file.path, file); const worker = inventory.get('worker'); Check.require(worker?.sha256 === plan.composition.worker.sha256 && worker.size === plan.composition.worker.size && worker.mode === 0o500, 'MIGRATION_ARTIFACT_INTEGRITY'); const providers = state.directory('artifacts/providers', true); try {
        const expected = plan.composition.services.filter(this.external), seen = new Set<string>();
        Check.require(providers.entries().length === expected.length, 'MIGRATION_ARTIFACT_INTEGRITY');
        for (const digest of providers.entries()) {
            Check.require(/^[a-f0-9]{64}$/.test(digest), 'MIGRATION_ARTIFACT_INTEGRITY');
            const root = providers.directory(digest), prefix = 'artifacts/providers/' + digest + '/';
            try {
                const descriptor = inventory.get(prefix + 'manifest.json');
                Check.require(descriptor?.mode === 0o400 && descriptor.sha256 === digest, 'MIGRATION_ARTIFACT_INTEGRITY');
                const parsed = ProviderSchemas.manifest.safeParse(StrictJson.parse(root.file('manifest.json', digest, 4 * 1024 * 1024)));
                Check.require(parsed.success, 'MIGRATION_ARTIFACT_INTEGRITY');
                const manifest = parsed.data, service = expected.find(this.match.bind(null, manifest));
                Check.require(service && manifest.target === 'deployment' && manifest.scopeId === 'installation:' + plan.configuration.installationId && !seen.has(service.role), 'MIGRATION_ARTIFACT_INTEGRITY');
                seen.add(service.role);
                const artifact = plan.artifacts.find(this.package.bind(null, manifest.package.name));
                Check.require(artifact?.kind === 'package' && artifact.version === manifest.package.version, 'MIGRATION_ARTIFACT_INTEGRITY');
                const actual = [];
                for (const file of files)
                    if (file.kind === 'file' && file.path.startsWith(prefix) && file.path !== prefix + 'manifest.json') {
                        Check.require(file.mode === 0o400, 'MIGRATION_ARTIFACT_INTEGRITY');
                        actual.push({ path: file.path.slice(prefix.length), sha256: file.sha256 });
                    }
                Check.require(CanonicalJson.stringify(actual.sort(this.path)) === CanonicalJson.stringify([...manifest.files].sort(this.path)), 'MIGRATION_ARTIFACT_INTEGRITY');
                const metadata = StrictJson.object(StrictJson.parse(root.file('package.json', undefined, 4 * 1024 * 1024)));
                Check.require(metadata.name === manifest.package.name && metadata.version === manifest.package.version, 'MIGRATION_ARTIFACT_INTEGRITY');
            }
            finally {
                root.close();
            }
        }
    }
    finally {
        providers.close();
    } const images = state.directory('artifacts/images', true); try {
        const bindings = StrictJson.object(StrictJson.parse(images.file('bindings.json', undefined, 1024 * 1024, true)));
        Check.require(bindings.planDigest === plan.digest, 'MIGRATION_ARTIFACT_INTEGRITY');
        for (const service of plan.composition.services) {
            const artifact = plan.artifacts.find(this.image.bind(null, plan.recipe.services[service.role]!.image));
            Check.require(artifact?.kind === 'image', 'MIGRATION_ARTIFACT_INTEGRITY');
            const image = images.directory(service.imageId, true), prefix = 'artifacts/images/' + service.imageId + '/';
            try {
                Check.require(StrictJson.object(StrictJson.parse(image.file('oci-layout', undefined, 1024, true))).imageLayoutVersion === '1.0.0', 'MIGRATION_ARTIFACT_INTEGRITY');
                const index = StrictJson.object(StrictJson.parse(image.file('index.json', undefined, 4 * 1024 * 1024, true)));
                Check.require(index.schemaVersion === 2 && Array.isArray(index.manifests) && index.manifests.length === 1, 'MIGRATION_ARTIFACT_INTEGRITY');
                const selection = StrictJson.object(index.manifests[0]);
                Check.require(selection.digest === 'sha256:' + artifact.manifestDigest, 'MIGRATION_ARTIFACT_INTEGRITY');
                const manifestFile = inventory.get(prefix + 'blobs/sha256/' + artifact.manifestDigest);
                Check.require(manifestFile?.sha256 === artifact.manifestDigest && manifestFile.size === selection.size, 'MIGRATION_ARTIFACT_INTEGRITY');
                const manifest = StrictJson.object(StrictJson.parse(image.file('blobs/sha256/' + artifact.manifestDigest, artifact.manifestDigest, 4 * 1024 * 1024, true))), configuration = StrictJson.object(manifest.config);
                Check.require(configuration.digest === 'sha256:' + artifact.configDigest && Array.isArray(manifest.layers), 'MIGRATION_ARTIFACT_INTEGRITY');
                const expected = new Set(['oci-layout', 'index.json', 'blobs/sha256/' + artifact.manifestDigest]);
                for (const value of [configuration, ...manifest.layers]) {
                    const blob = StrictJson.object(value);
                    Check.require(typeof blob.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(blob.digest), 'MIGRATION_ARTIFACT_INTEGRITY');
                    const path = 'blobs/sha256/' + blob.digest.slice(7), file = inventory.get(prefix + path);
                    Check.require(file?.sha256 === blob.digest.slice(7) && file.size === blob.size, 'MIGRATION_ARTIFACT_INTEGRITY');
                    expected.add(path);
                }
                const actual = [];
                for (const file of files)
                    if (file.kind === 'file' && file.path.startsWith(prefix))
                        actual.push(file.path.slice(prefix.length));
                Check.require(CanonicalJson.stringify(actual.sort()) === CanonicalJson.stringify([...expected].sort()), 'MIGRATION_ARTIFACT_INTEGRITY');
            }
            finally {
                image.close();
            }
        }
    }
    finally {
        images.close();
    } }
    private static external(service: InstalledPlan['composition']['services'][number]): boolean { return service.package !== null; }
    private static match(manifest: {
        providerId: string;
        entry: string;
        package: {
            name: string;
        };
    }, service: InstalledPlan['composition']['services'][number]): boolean { return service.provider.id === manifest.providerId && service.entry === manifest.entry && service.package === manifest.package.name; }
    private static package(name: string, artifact: InstalledPlan['artifacts'][number]): boolean { return artifact.kind === 'package' && artifact.name === name; }
    private static image(reference: string, artifact: InstalledPlan['artifacts'][number]): boolean { return artifact.kind === 'image' && artifact.reference === reference; }
    private static path(left: {
        path: string;
    }, right: {
        path: string;
    }): number { return left.path < right.path ? -1 : left.path > right.path ? 1 : 0; }
}

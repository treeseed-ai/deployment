import addFormats from 'ajv-formats';
import { ServiceProjection } from './service-projection.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { PlatformSchemas, ServiceSchemas, PluginManagementSchemas, CanonicalJson, PlanningBlockedError, type ServiceRelease, type ServiceInstance, type PluginPackageDescriptor, type PluginExportDescriptor, type DeploymentRecipe, type DeploymentPlan } from '@treeseed-cordis/sdk';
import { ArtifactResolver, ArchiveMetadata, type PackageData } from './artifacts.js';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';
export interface ServiceArtifactResolution {
    inventory: ServiceRelease;
    recipe: DeploymentRecipe;
    pluginBindings: PluginExportDescriptor['declaration'][];
    artifacts: DeploymentPlan['artifacts'];
    releaseDigest: string;
    lockDigest: string;
    recipeDigest: string;
}
/** Exact data inspection only. No provider imports or acquisition. */
class ServiceArtifactVerifier extends ArtifactResolver {
    async resolveService(input: unknown): Promise<ServiceArtifactResolution> {
        const configuration = ServiceSchemas.configuration.parse(input), directory = SafeDirectory.open(configuration.release.directory);
        try {
            const inventory = this.schema(ServiceSchemas.release.safeParse(StrictJson.parse(directory.file('release.json', configuration.release.manifestDigest)))), root = StrictJson.object(StrictJson.parse(directory.file(inventory.packageJson.path, inventory.packageJson.sha256))), lock = StrictJson.object(StrictJson.parse(directory.file(inventory.lockfile.path, inventory.lockfile.sha256), true)), recipe = this.schema(ServiceSchemas.plan.shape.recipe.safeParse(StrictJson.parse(directory.file(inventory.recipe.path, inventory.recipe.sha256))));
            Check.require(inventory.packages.length <= 256 && inventory.images.length <= 64, 'INVENTORY_LIMIT');
            const packages = new Map<string, PackageData>(), paths = new Set<string>();
            let total = 0, files = 0;
            for (const entry of inventory.packages) {
                Check.require(!packages.has(entry.name) && !paths.has(entry.path), 'DUPLICATE_PACKAGE');
                paths.add(entry.path);
                const bytes = directory.file(entry.path, entry.sha256), reader = new ArchiveMetadata(bytes), metadata = await reader.read();
                total += reader.bytes;
                files += reader.hashes.size;
                Check.require(total <= 64 * 1024 * 1024 && files <= 4096 && reader.maximumFile <= 8 * 1024 * 1024, 'PROVIDER_CLOSURE');
                for (const path of reader.paths)
                    Check.require(PlatformSchemas.relative.safeParse(path).success, 'PROVIDER_PATH');
                Check.require(metadata.name === entry.name && metadata.version === entry.version, 'PACKAGE_IDENTITY');
                packages.set(entry.name, { entry, bytes, metadata, files: reader.paths, hashes: reader.hashes, sizes: reader.sizes });
            }
            this.lock(root, lock, packages, true);
            const descriptors = this.packages(configuration.plugins, inventory, packages), bindings: ServiceArtifactResolution['pluginBindings'] = [], selected = new Set<string>();
            for (const service of inventory.composition.services) {
                const container = this.provider(service.provider, descriptors, packages, 'container.service'), probe = this.provider(service.readiness.provider, descriptors, packages, 'probe.service');
                this.configuration(container, service.configuration);
                this.configuration(probe, service.readiness.configuration);
                this.service(service, container, probe, inventory, configuration);
                const owner = descriptors.get(service.provider.package.name)!;
                const ownerData = packages.get(service.provider.package.name)!;
                for (const image of owner.runtimeImages ?? []) if (image.id === service.definition.imageId) { Check.require(ownerData.hashes.has('package/' + image.entry), 'RUNTIME_ENTRY_INTEGRITY'); }
                let imageBound = false;
                for (const image of owner.images)
                    if (image.id === service.definition.imageId)
                        imageBound = true;
                for (const image of owner.runtimeImages ?? []) if (image.id === service.definition.imageId) imageBound = true;
                Check.require(imageBound, 'IMAGE_PACKAGE_BINDING');
                for (const value of [container.declaration, probe.declaration]) {
                    const key = value.target + ':' + value.id;
                    if (!selected.has(key)) {
                        selected.add(key);
                        bindings.push(value);
                    }
                }
            }
            this.recipeProjection(configuration, inventory, recipe);
            this.assets(inventory, descriptors, packages);
            const worker = inventory.composition.worker;
            Check.require(directory.file(worker.path, worker.sha256, 512 * 1024 * 1024).length === worker.size, 'WORKER_INTEGRITY');
            const artifacts: DeploymentPlan['artifacts'] = [];
            for (const name of [...packages.keys()].sort()) {
                const entry = packages.get(name)!.entry;
                artifacts.push({ kind: 'package', name, version: entry.version, sha256: entry.sha256 });
            }
            const images = [...inventory.images];
            images.sort(ArtifactResolver.imageOrder);
            for (const image of images)
                artifacts.push(this.image(directory, image, true));
            this.runtimeImages(directory, inventory, artifacts, packages, descriptors);
            await this.helpers(directory, inventory);
            directory.verify();
            return { inventory, recipe, pluginBindings: bindings, artifacts, releaseDigest: configuration.release.manifestDigest, lockDigest: inventory.lockfile.sha256, recipeDigest: inventory.recipe.sha256 };
        }
        catch (error) {
            if (error instanceof PlanningBlockedError)
                throw error;
            return Check.block('INVALID_SERVICE_RELEASE');
        }
        finally {
            directory.close();
        }
    }
    private packages(selections: Array<{
        id: string;
        package: string;
        version: string;
        integrity: string;
    }>, inventory: ServiceRelease, packages: Map<string, PackageData>): Map<string, PluginPackageDescriptor> {
        const result = new Map<string, PluginPackageDescriptor>(), ids = new Set<string>();
        for (const selection of selections) {
            Check.require(!ids.has(selection.id) && !result.has(selection.package), 'DUPLICATE_PLUGIN');
            ids.add(selection.id);
            const data = packages.get(selection.package);
            Check.require(data && data.entry.version === selection.version && data.entry.sha256 === selection.integrity, 'PLUGIN_ARTIFACT_MISMATCH');
            const descriptor = this.schema(PluginManagementSchemas.packageDescriptor.safeParse(data.metadata.cordisPackage));
            Check.require(descriptor.pluginId === selection.id && descriptor.package.name === data.entry.name && descriptor.package.version === data.entry.version, 'PACKAGE_IDENTITY');
            result.set(selection.package, descriptor);
        }
        for (const id of inventory.requiredPluginIds)
            Check.require(ids.has(id), 'MISSING_PLUGIN');
        for (const capability of inventory.requiredServices) {
            let found = false;
            for (const descriptor of result.values())
                for (const provider of descriptor.providers)
                    if (provider.declaration.capability === capability)
                        found = true;
            Check.require(found, 'MISSING_SERVICE');
        }
        return result;
    }
    private provider(reference: ServiceInstance['provider'], descriptors: Map<string, PluginPackageDescriptor>, packages: Map<string, PackageData>, capability: string): PluginExportDescriptor {
        const data = packages.get(reference.package.name), descriptor = descriptors.get(reference.package.name);
        Check.require(data && descriptor && reference.package.sha256 === data.entry.sha256 && reference.package.version === data.entry.version && reference.pluginId === descriptor.pluginId, 'SERVICE_PACKAGE_MISMATCH');
        let selected: PluginExportDescriptor | undefined;
        for (const item of descriptor.providers)
            if (item.declaration.id === reference.providerId && item.declaration.target === reference.target) {
                Check.require(!selected, 'DUPLICATE_PROVIDER');
                selected = item;
            }
        Check.require(selected && selected.entry === reference.entry && selected.classExport === reference.classExport && selected.declaration.capability === capability && selected.declaration.contractVersion === reference.contractVersion && data.files.has('package/' + selected.entry), 'SERVICE_PROVIDER_MISMATCH');
        Check.require(selected.declaration.provide.length === 1 && selected.declaration.provide[0] === capability && CanonicalJson.stringify([...selected.declaration.inject].sort()) === CanonicalJson.stringify(capability === 'container.service' ? ['deployment.services', 'service.context'] : []), 'DECLARATION_DRIFT');
        return selected;
    }
    private configuration(provider: PluginExportDescriptor, value: Record<string, unknown>): void {
        try {
            const validator = new Ajv2020({ strict: true, allErrors: false, useDefaults: true, coerceTypes: false, removeAdditional: false });
            addFormats(validator);
            const validate = validator.compile(provider.configurationSchema);
            Check.require(Reflect.get(validate, '$async') !== true, 'UNSUPPORTED_CONFIGURATION_SCHEMA');
            Check.require(validate(value) === true, 'INVALID_PROVIDER_CONFIGURATION');
        }
        catch (error) {
            if (error instanceof PlanningBlockedError)
                throw error;
            Check.block('UNSUPPORTED_CONFIGURATION_SCHEMA');
        }
    }
    private service(service: ServiceInstance, container: PluginExportDescriptor, probe: PluginExportDescriptor, inventory: ServiceRelease, configuration: ReturnType<typeof ServiceSchemas.configuration.parse>): void {
        Check.require(container.container && probe.probe, 'MISSING_PROVIDER_PROJECTION');
        const projected = ServiceProjection.resolve(service, container.container, inventory.composition, configuration);
        const definition = JSON.parse(CanonicalJson.stringify(service.definition)) as ServiceInstance['definition'];
        for (const port of definition.ports)
            delete port.publication;
        Check.require(CanonicalJson.stringify(definition) === CanonicalJson.stringify(projected.definition) && CanonicalJson.stringify(service.resources) === CanonicalJson.stringify(projected.resources) && CanonicalJson.stringify(service.transitionPolicy) === CanonicalJson.stringify(container.container.transitionPolicy) && service.readiness.observationContract === container.container.observationContract, 'SERVICE_DEFINITION_MISMATCH');
        Check.require(service.bindings.length === container.container.providedContracts.length, 'SERVICE_BINDING_MISMATCH');
        for (const binding of service.bindings) {
            let count = 0;
            for (const provided of container.container.providedContracts)
                if (provided.port===binding.port&&provided.contractId === binding.contractId && provided.contractVersion === binding.contractVersion)
                    count++;
            Check.require(count === 1, 'SERVICE_BINDING_MISMATCH');
        }
        Check.require(service.dependencies.length === container.container.dependencies.length, 'SERVICE_BINDING_MISMATCH');
        for (const dependency of service.dependencies) {
            let found = false;
            for (const required of container.container.dependencies)
                if (required.port === dependency.port && required.contractId === dependency.contractId && required.contractVersion === dependency.contractVersion)
                    found = true;
            Check.require(found, 'SERVICE_BINDING_MISMATCH');
        }
        Check.require(probe.probe.schemes.includes(service.readiness.scheme)&&probe.probe.observationContracts.includes(service.readiness.observationContract) && service.readiness.deadlineMs <= probe.probe.maximumDeadlineMs, 'PROBE_CONTRACT_MISMATCH');
        let image: ServiceRelease['images'][number] | undefined;
        for (const item of inventory.images)
            if (item.id === service.definition.imageId) {
                Check.require(!image, 'DUPLICATE_IMAGE');
                image = item;
            }
        Check.require(image, 'MISSING_IMAGE');
    }
    static resourceKey(serviceId: string, slot: string): string { return 'r-' + CanonicalJson.digest({ serviceId, slot }).slice(0, 48); }
    private recipeProjection(configuration: ReturnType<typeof ServiceSchemas.configuration.parse>, inventory: ServiceRelease, recipe: DeploymentRecipe): void {
        const services: DeploymentRecipe['services'] = {}, volumes: DeploymentRecipe['volumes'] = {}, secrets: DeploymentRecipe['secrets'] = {}, usedImages = new Set<string>(), references: string[] = [], bindings = new Map<string, string>();
        let publications = 0;
        for (const service of inventory.composition.services)
            for (const binding of service.bindings)
                bindings.set(binding.bindingId, service.serviceId);
        for (const service of inventory.composition.services) {
            const image = inventory.images.find(ServiceArtifactVerifier.matchesImage.bind(null, service.definition.imageId))!;
            Check.require(image.reference.endsWith('@sha256:' + image.manifestDigest) && !image.reference.split('@')[0]!.split('/').at(-1)!.includes(':'), 'IMAGE_REFERENCE_MISMATCH');
            usedImages.add(image.id);
            const expected: DeploymentRecipe['services'][string] = { image: image.reference }, dependencies: string[] = [];
            for (const dependency of service.dependencies)
                dependencies.push(bindings.get(dependency.bindingId)!);
            if (dependencies.length)
                expected.depends_on = [...new Set(dependencies)].sort();
            if (service.definition.ports.some(ServiceArtifactVerifier.published)) {
                expected.ports = [];
                for (const port of service.definition.ports)
                    if (port.publication) {
                        const origin = new URL(configuration.origin);
                        Check.require(port.publication.port === Number(origin.port || (origin.protocol === 'https:' ? 443 : 80)) && port.publication.host === (origin.hostname === '[::1]' ? '::1' : '127.0.0.1'), 'ORIGIN_PORT_MISMATCH');
                        publications++;
                        expected.ports.push({ target: port.target, published: port.publication.port, host_ip: port.publication.host, protocol: 'tcp' });
                    }
            }
            for (const name of service.resources.volumes)
                volumes[ServiceArtifactVerifier.resourceKey(service.serviceId, name)] = {};
            if (service.definition.volumes.length) {
                expected.volumes = [];
                for (const volume of service.definition.volumes)
                    expected.volumes.push({ type: 'volume', source: ServiceArtifactVerifier.resourceKey(service.serviceId, volume.source), target: volume.target, read_only: volume.readOnly });
            }
            for (const slot of Object.keys(service.resources.slots)) {
                const key = ServiceArtifactVerifier.resourceKey(service.serviceId, slot);
                secrets[key] = { file: '.cordis/credentials/' + service.serviceId + '/' + slot };
                references.push('secret://' + service.serviceId + '/' + slot);
            }
            if (service.definition.secrets.length) {
                expected.secrets = [];
                for (const secret of service.definition.secrets)
                    expected.secrets.push(ServiceArtifactVerifier.resourceKey(service.serviceId, secret.slot));
            }
            services[service.serviceId] = expected;
        }
        Check.require(publications === 1, 'ORIGIN_PORT_MISMATCH');
        Check.require(usedImages.size === inventory.images.length, 'UNUSED_IMAGE');
        Check.require(CanonicalJson.stringify(references.sort()) === CanonicalJson.stringify([...configuration.credentialReferences].sort()), 'INVALID_SECRET_REFERENCE');
        const actual = JSON.parse(CanonicalJson.stringify(recipe)) as DeploymentRecipe;
        for (const service of Object.values(actual.services))
            if (service.depends_on)
                service.depends_on.sort();
        Check.require(CanonicalJson.stringify({ services, volumes, secrets }) === CanonicalJson.stringify(actual), 'SERVICE_RECIPE_MISMATCH');
    }
    private static matchesImage(id: string, image: ServiceRelease['images'][number]): boolean { return image.id === id; }
    private static published(port: ServiceInstance['definition']['ports'][number]): boolean { return port.publication !== undefined; }
    private assets(inventory: ServiceRelease, descriptors: Map<string, PluginPackageDescriptor>, packages: Map<string, PackageData>): void {
        const assets: Array<{
            package: string;
            version: string;
            path: string;
            sha256: string;
        }> = [];
        for (const name of [...descriptors.keys()].sort()) {
            const descriptor = descriptors.get(name)!, data = packages.get(name)!;
            for (const asset of descriptor.assets) {
                Check.require(data.hashes.get('package/' + asset.path) === asset.sha256 && data.sizes.get('package/' + asset.path) === asset.size, 'ASSET_INTEGRITY');
                assets.push({ package: name, version: descriptor.package.version, path: asset.path, sha256: asset.sha256 });
            }
            for (const image of descriptor.images) {
                let found = false;
                for (const item of inventory.images)
                    if (item.id === image.id && item.reference === image.reference && item.indexSha256 === image.indexSha256 && item.manifestDigest === image.manifestDigest)
                        found = true;
                Check.require(found, 'IMAGE_PACKAGE_BINDING');
            }
        }
        assets.sort(ServiceArtifactVerifier.assetOrder);
        Check.require(CanonicalJson.digest(assets) === inventory.composition.assetDigest, 'ASSET_SET_MISMATCH');
    }
    private static assetOrder(a: {
        package: string;
        path: string;
    }, b: {
        package: string;
        path: string;
    }): number { const left = a.package + ':' + a.path, right = b.package + ':' + b.path; return left < right ? -1 : left > right ? 1 : 0; }
    private runtimeImages(directory: SafeDirectory, inventory: ServiceRelease, artifacts: DeploymentPlan['artifacts'], data: Map<string, PackageData>, descriptors: Map<string, PluginPackageDescriptor>): void {
        const owners = new Map<string, string>();
        for (const [name, descriptor] of descriptors) for (const image of [...descriptor.images, ...descriptor.runtimeImages ?? []]) { Check.require(!owners.has(image.id), 'IMAGE_PACKAGE_BINDING'); owners.set(image.id, name); }
        const verified = new Set<string>();
        for (const service of inventory.composition.services) {
            const owner = descriptors.get(service.provider.package.name)!;
            let runtime: NonNullable<PluginPackageDescriptor['runtimeImages']>[number] | undefined;
            for (const candidate of owner.runtimeImages ?? []) if (candidate.id === service.definition.imageId) runtime = candidate;
            // A host receiving the private worker capability must be an exact runtime image.
            Check.require(!service.definition.workerSocket || runtime, 'IMAGE_PACKAGE_BINDING');
            if (!runtime || verified.has(runtime.id)) continue;
            verified.add(runtime.id);
            const image = inventory.images.find(ServiceArtifactVerifier.matchesImage.bind(null, runtime.id))!, packages: DeploymentPlan['artifacts'] = [], closure = new Set<string>(), queue = [service.provider.package.name];
            while (queue.length) { const name = queue.shift()!; if (closure.has(name)) continue; const entry = data.get(name); Check.require(entry, 'MISSING_PACKAGE'); closure.add(name); for (const field of ['dependencies', 'peerDependencies']) { const entries = entry.metadata[field]; if (entries !== undefined) for (const dependency of Object.keys(StrictJson.object(entries))) if (data.has(dependency)) queue.push(dependency); } }
            let configDigest = '';
            for (const artifact of artifacts) if (artifact.kind === 'package') { if (closure.has(artifact.name)) packages.push(artifact); } else if (artifact.manifestDigest === image.manifestDigest) configDigest = artifact.configDigest;
            Check.require(configDigest, 'MISSING_IMAGE');
            const entryDigest = data.get(service.provider.package.name)!.hashes.get('package/' + runtime.entry);
            Check.require(entryDigest, 'RUNTIME_ENTRY_INTEGRITY');
            const layout = directory.directory(image.layout);
            try {
                const config = StrictJson.object(StrictJson.parse(layout.file('blobs/sha256/' + configDigest, configDigest, 4 * 1024 * 1024))), labels = StrictJson.object(StrictJson.object(config.config).Labels);
                Check.require(labels['ai.treeseed.cordis.package-set'] === CanonicalJson.digest(packages) && labels['ai.treeseed.cordis.admin-asset'] === inventory.composition.assetDigest && labels['ai.treeseed.cordis.runtime-entry'] === entryDigest, 'IMAGE_PACKAGE_BINDING');
            } finally { layout.close(); }
        }
        for (const descriptor of descriptors.values()) for (const image of descriptor.runtimeImages ?? []) Check.require(verified.has(image.id), 'UNUSED_IMAGE');
    }
    private async helpers(directory: SafeDirectory, inventory: ServiceRelease): Promise<void> {
        for (const helper of inventory.helpers?.helpers ?? []) {
            Check.require(helper.path, 'PREPARED_HELPER_REQUIRED');
            const bytes = directory.file(helper.path, helper.sha256, 512 * 1024 * 1024);
            Check.require(bytes.length === helper.size, 'HELPER_INTEGRITY');
            const reader = new ArchiveMetadata(bytes, true); await reader.read();
            Check.require(reader.hashes.size === helper.files.length && reader.bytes <= 512 * 1024 * 1024 && reader.paths.size <= 16384, 'HELPER_INTEGRITY');
            for (const path of reader.paths) Check.require(PlatformSchemas.relative.safeParse(path).success, 'HELPER_INTEGRITY');
            for (const file of helper.files) Check.require(reader.hashes.get(file.path) === file.sha256 && reader.modes.get(file.path) === file.mode, 'HELPER_INTEGRITY');
        }
    }
    private static serviceId(id: string, service: ServiceInstance): boolean { return service.serviceId === id; }
}
export class ServiceArtifactResolver {
    resolve(input: unknown): Promise<ServiceArtifactResolution> { return new ServiceArtifactVerifier().resolveService(input); }
}

import { chmodSync, fsyncSync, lstatSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CanonicalJson, ProviderV4Schemas, ServiceSchemas, type ServicePlan, type ServiceRelease } from '@treeseed-cordis/sdk';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';
import { InstallationStore, InstallationWriter, PackageArchiveMaterializer } from './installed.js';
import { ArchiveMetadata } from './artifacts.js';
import { ServiceArtifactResolver } from './service-artifacts.js';
import { ServicePlanIdentity, ServicePlanStore } from './service-plan.js';
export interface PreparedServiceProvider {
    file: string;
    digest: string;
    scopeId: string;
}
interface StagePackage {
    entry: ServiceRelease['packages'][number];
    metadata: Record<string, unknown>;
    hashes: Map<string, string>;
}
export class ServiceProviderStager {
    private static turn(done: (value: void) => void): void { setImmediate(done); }
    private readonly plan: ServicePlan;
    private readonly store: ServicePlanStore;
    constructor(plan: ServicePlan) { this.plan = ServiceSchemas.plan.parse(plan); this.store = new ServicePlanStore(this.plan.configuration.installationDirectory); }
    async stage(serviceId: string, kind: 'container' | 'probe', writer: InstallationWriter): Promise<PreparedServiceProvider> {
        await new Promise(ServiceProviderStager.turn); writer.assert(this.store.path);
        Check.require(kind === 'container' || kind === 'probe', 'PROVIDER_KIND');
        let accepted = false;
        for (const record of this.store.records())
            if (record.planId === this.plan.id && record.digest === this.plan.digest && record.phase === 'stage')
                accepted = true;
        Check.require(accepted, 'ACCEPTED_STAGE_REQUIRED');
        const saved = this.store.read(this.plan.id, this.plan.digest);
        Check.require(CanonicalJson.stringify(saved) === CanonicalJson.stringify(this.plan), 'PLAN_BINDING');
        const service = this.plan.composition.services.find(ServiceProviderStager.matches.bind(null, serviceId));
        Check.require(service, 'SERVICE_SCOPE');
        const ref = kind === 'container' ? service.provider : service.readiness.provider, configuration = kind === 'container' ? service.configuration : service.readiness.configuration, resolved = await new ServiceArtifactResolver().resolve(this.plan.configuration);
        Check.require(resolved.releaseDigest === this.plan.releaseDigest && resolved.lockDigest === this.plan.lockDigest && resolved.recipeDigest === this.plan.recipeDigest && CanonicalJson.stringify(resolved.artifacts) === CanonicalJson.stringify(this.plan.artifacts) && CanonicalJson.stringify(ServicePlanIdentity.graph(resolved.inventory.composition)) === CanonicalJson.stringify(this.plan.composition), 'PLAN_BINDING');
        const bundle = SafeDirectory.open(this.plan.configuration.release.directory), packages = new Map<string, StagePackage>();
        try {
            for (const entry of resolved.inventory.packages) {
                const reader = new ArchiveMetadata(bundle.file(entry.path, entry.sha256)), metadata = await reader.read();
                packages.set(entry.name, { entry, metadata, hashes: reader.hashes });
            }
            const closure = new Set<string>(), queue = [ref.package.name];
            while (queue.length) {
                const name = queue.shift()!;
                if (closure.has(name))
                    continue;
                const data = packages.get(name);
                Check.require(data, 'MISSING_PACKAGE');
                closure.add(name);
                for (const field of ['dependencies', 'peerDependencies'])
                    if (data.metadata[field] !== undefined)
                        for (const dependency of Object.keys(StrictJson.object(data.metadata[field])))
                            if (packages.has(dependency))
                                queue.push(dependency);
            }
            const files: Array<{
                path: string;
                sha256: string;
            }> = [];
            for (const name of [...closure].sort()) {
                const data = packages.get(name)!;
                for (const [archivePath, sha256] of data.hashes) {
                    Check.require(archivePath.startsWith('package/'), 'PROVIDER_PATH');
                    const relative = archivePath.slice(8);
                    Check.require(relative && !relative.split('/').includes('node_modules'), 'NESTED_PROVIDER_RESOLUTION');
                    files.push({ path: (name === ref.package.name ? '' : 'node_modules/' + name + '/') + relative, sha256 });
                }
            }
            for(const file of files)Check.require(file.path!=='manifest.json','PROVIDER_RESERVED_PATH');
            files.sort(ServiceProviderStager.order);
            Check.require(new Set(files.map(ServiceProviderStager.path)).size === files.length, 'PROVIDER_PATH_CONFLICT');
            const scopeId = 'installation:' + this.plan.configuration.installationId + ':service:' + serviceId, manifest = ProviderV4Schemas.manifest.parse({ formatVersion: 2, contractVersion: ProviderV4Schemas.version, target: 'deployment', scopeId, providerId: ref.providerId, package: { name: ref.package.name, version: ref.package.version }, entry: ref.entry, classExport: ref.classExport, configuration, files }), bytes = CanonicalJson.stringify(manifest) + '\n', digest = createHash('sha256').update(bytes).digest('hex');
            writer.assert(this.store.path);
            const artifacts = this.store.directory('artifacts', writer);
            let providers: SafeDirectory;
            try {
                providers = artifacts.entries().includes('providers') ? artifacts.directory('providers', true) : InstallationStore.mkdir(artifacts, 'providers');
            }
            finally {
                artifacts.close();
            }
            try {
                this.audit(providers);
                if (providers.entries().includes(digest))
                    return { file: join(providers.path, digest, 'manifest.json'), digest, scopeId };
                const temporary = 'building-' + randomUUID(), root = InstallationStore.mkdir(providers, temporary);
                try {
                    const ordered = [ref.package.name];
                    for (const name of [...closure].sort())
                        if (name !== ref.package.name)
                            ordered.push(name);
                    for (const name of ordered) {
                        const data = packages.get(name)!;
                        let target = root;
                        if (name !== ref.package.name) {
                            let modules = root.entries().includes('node_modules') ? root.directory('node_modules', true) : InstallationStore.mkdir(root, 'node_modules');
                            try {
                                const parts = name.split('/');
                                if (parts.length === 2) {
                                    const scope = parts.shift()!, parent = modules.entries().includes(scope) ? modules.directory(scope, true) : InstallationStore.mkdir(modules, scope);
                                    modules.close();
                                    modules = parent;
                                }
                                target = InstallationStore.mkdir(modules, parts[0]!);
                            }
                            finally {
                                modules.close();
                            }
                        }
                        try {
                            await PackageArchiveMaterializer.materializePrivate(join(bundle.path, data.entry.path), data.entry.sha256, target.path);
                        }
                        finally {
                            if (target !== root)
                                target.close();
                        }
                    }
                    const actual: Array<{
                        path: string;
                        sha256: string;
                    }> = [];
                    this.inventory(root, root.path, actual, false);
                    actual.sort(ServiceProviderStager.order);
                    Check.require(CanonicalJson.stringify(actual) === CanonicalJson.stringify(files), 'PROVIDER_STAGE_INTEGRITY');
                    writer.assert(this.store.path);
                    const destination = InstallationStore.mkdir(providers, digest);
                    try {
                        for (const name of root.entries())
                            renameSync(root.childPath(name), destination.childPath(name));
                        InstallationStore.publish(destination, 'manifest.json', bytes, 0o400);
                        this.immutable(destination);
                        fsyncSync(destination.fd);
                        fsyncSync(providers.fd);
                    }
                    finally {
                        destination.close();
                    }
                    this.audit(providers, temporary);
                    return { file: join(providers.path, digest, 'manifest.json'), digest, scopeId };
                }
                finally {
                    try {
                        root.verify();
                    }
                    finally {
                        root.close();
                    }
                    rmSync(providers.childPath(temporary), { recursive: true, force: true });
                    fsyncSync(providers.fd);
                    providers.verify();
                }
            }
            finally {
                providers.close();
            }
        }
        finally {
            bundle.close();
        }
    }
    private static matches(id: string, value: {
        serviceId: string;
    }): boolean { return value.serviceId === id; }
    private static order(a: {
        path: string;
    }, b: {
        path: string;
    }): number { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; }
    private static path(value: {
        path: string;
    }): string { return value.path; }
    private inventory(directory: SafeDirectory, root: string, files: Array<{
        path: string;
        sha256: string;
    }>, immutable: boolean): void { for (const name of directory.entries()) {
        const stat = lstatSync(directory.childPath(name));
        Check.require(!stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === (stat.isDirectory() ? (immutable ? 0o500 : 0o700) : (immutable ? 0o400 : 0o600)), 'PROVIDER_STAGE_MODE');
        if (stat.isDirectory()) {
            const child = directory.directory(name);
            try {
                this.inventory(child, root, files, immutable);
            }
            finally {
                child.close();
            }
        }
        else {
            const bytes = directory.file(name, undefined, 8 * 1024 * 1024);
            files.push({ path: (directory.path === root ? '' : directory.path.slice(root.length + 1) + '/') + name, sha256: createHash('sha256').update(bytes).digest('hex') });
        }
    } }
    private audit(providers: SafeDirectory, ignored?: string): void { for (const name of providers.entries()) {
        if (name === ignored)
            continue;
        Check.require(/^[a-f0-9]{64}$/.test(name), 'STAGING_REPAIR_REQUIRED');
        const directory = providers.directory(name);
        try {
            Check.require((lstatSync(providers.childPath(name)).mode & 0o777) === 0o500, 'STAGING_REPAIR_REQUIRED');
            const bytes = directory.file('manifest.json', name, 4 * 1024 * 1024), parsed = ProviderV4Schemas.manifest.safeParse(StrictJson.parse(bytes));
            Check.require(parsed.success, 'STAGING_REPAIR_REQUIRED');
            const actual: Array<{
                path: string;
                sha256: string;
            }> = [];
            this.inventory(directory, directory.path, actual, true);
            const expected = [...parsed.data.files, { path: 'manifest.json', sha256: name }];
            actual.sort(ServiceProviderStager.order);
            expected.sort(ServiceProviderStager.order);
            Check.require(CanonicalJson.stringify(actual) === CanonicalJson.stringify(expected), 'PROVIDER_STAGE_INTEGRITY');
        }
        finally {
            directory.close();
        }
    } providers.verify(); }
    private immutable(directory: SafeDirectory): void { for (const name of directory.entries()) {
        const stat = lstatSync(directory.childPath(name));
        if (stat.isDirectory()) {
            const child = directory.directory(name);
            try {
                this.immutable(child);
            }
            finally {
                child.close();
            }
        }
        else
            chmodSync(directory.childPath(name), 0o400);
    } chmodSync('/proc/self/fd/' + directory.fd, 0o500); }
}

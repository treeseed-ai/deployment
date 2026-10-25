import { ServiceJournal } from './service-journal.js';
import { type ServiceApplicationRecord, type ServiceResourceReceipt, type ServiceSnapshot, type ServiceWorkerRequest } from '@treeseed-cordis/sdk';
import { lstatSync, fstatSync, mkdirSync, fsyncSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { InstallationStore, InstallationWriter } from './installed.js';
import { PlanStore } from './filesystem.js';
import { resolve } from 'node:path';
import { ServiceSchemas, PlatformSchemas, CanonicalJson, type ServicePlan, type ServiceInstance, type ServiceGraph } from '@treeseed-cordis/sdk';
import type { DiagnosticCommands, DiagnosticSystem } from './diagnose.js';
import { TcpTableProbe } from './diagnose.js';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';
import { ServiceArtifactResolver } from './service-artifacts.js';
export class ServicePlanIdentity {
    static service(service: ServiceInstance, image: unknown, configuration: ServicePlan['configuration'], engine: ServicePlan['expectedEngine']): string { return CanonicalJson.digest({ installationId: configuration.installationId, installationDirectory: configuration.installationDirectory, origin: configuration.origin, engine, service, image }); }
    static graph(graph: ServiceGraph): ServiceGraph {
        graph = ServiceSchemas.graph.parse(graph);
        graph.services.sort(this.byService);
        graph.profile.requiredBindings.sort();
        for (const service of graph.services) {
            service.bindings.sort(this.byBinding);
            service.dependencies.sort(this.byPort);
            service.definition.ports.sort(this.byId);
            service.definition.volumes.sort(this.byTarget);
            service.definition.secrets.sort(this.byTarget);
            service.resources.volumes.sort();
            service.resources.grants.sort(this.byGrant);
            service.resources.authorities.sort(this.byId);
            service.readiness.credentialReferences.sort();
        }
        return graph;
    }
    private static byService(a: ServiceInstance, b: ServiceInstance): number { return ServicePlanIdentity.compare(a.serviceId, b.serviceId); }
    private static compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
    private static byBinding(a: {
        bindingId: string;
    }, b: {
        bindingId: string;
    }): number { return ServicePlanIdentity.compare(a.bindingId, b.bindingId); }
    private static byPort(a: {
        port: string;
    }, b: {
        port: string;
    }): number { return ServicePlanIdentity.compare(a.port, b.port); }
    private static byId(a: {
        id: string;
    }, b: {
        id: string;
    }): number { return ServicePlanIdentity.compare(a.id, b.id); }
    private static byTarget(a: {
        target: string;
    }, b: {
        target: string;
    }): number { return ServicePlanIdentity.compare(a.target, b.target); }
    private static byGrant(a: {
        serviceId: string;
        slot: string;
    }, b: {
        serviceId: string;
        slot: string;
    }): number { return ServicePlanIdentity.compare(a.serviceId + ':' + a.slot, b.serviceId + ':' + b.slot); }
}
/** First format-3 plan-only slice; all activation remains behind the durable worker. */
export class ServicePlanningHost {
    constructor(private readonly commands: DiagnosticCommands, private readonly system: DiagnosticSystem) { }
    static isRelease(configuration: {
        release: {
            directory: string;
            manifestDigest: string;
        };
    }): boolean {
        const directory = SafeDirectory.open(configuration.release.directory);
        try {
            return StrictJson.object(StrictJson.parse(directory.file('release.json', configuration.release.manifestDigest))).formatVersion === 3;
        }
        finally {
            directory.close();
        }
    }
    private execute(args: string[]): string { const value = this.commands.execute(args); Check.require(value !== null, 'DOCKER_UNAVAILABLE'); return value; }
    async plan(input: unknown): Promise<ServicePlan> {
        const configuration = ServiceSchemas.configuration.parse(input);
        configuration.installationDirectory = resolve(configuration.installationDirectory);
        configuration.release.directory = resolve(configuration.release.directory);
        configuration.origin = new URL(configuration.origin).origin;
        configuration.plugins.sort(ServicePlanningHost.byPlugin);
        configuration.credentialReferences.sort();
        const path = configuration.installationDirectory, bundle = configuration.release.directory;
        Check.require(path !== bundle && !path.startsWith(bundle + '/') && !bundle.startsWith(path + '/'), 'OVERLAPPING_STORAGE');
        const host = this.system.host();
        Check.require(host.os === 'linux' && host.architecture === 'x64' && host.distribution === 'ubuntu' && host.release === '26.04', 'UNSUPPORTED_HOST');
        const storage = this.system.storage(path);
        Check.require(storage.code === 'OK', storage.code);
        const context = configuration.engineContext, endpoint = StrictJson.parse(Buffer.from(this.execute(['context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}'])));
        Check.require(typeof endpoint === 'string' && endpoint.startsWith('unix:///') && (!process.env.DOCKER_HOST || process.env.DOCKER_HOST === endpoint), 'REMOTE_ENGINE');
        const info = StrictJson.object(StrictJson.parse(Buffer.from(this.execute(['--context', context, 'info', '--format', '{{json .}}']))));
        Check.require(typeof info.ID === 'string' && info.ID.length > 0 && info.OSType === 'linux' && ['amd64', 'x86_64'].includes(String(info.Architecture)) && Number(info.NCPU) >= 2 && Number(info.MemTotal) >= 2 * 1024 ** 3, 'ENGINE_IDENTITY');
        const expectedEngine = PlatformSchemas.expectedEngine.parse({ context, endpoint, daemonId: info.ID, os: 'linux', architecture: 'amd64' });
        Check.require(StrictJson.object(StrictJson.parse(Buffer.from(this.execute(['--context', context, 'compose', 'version', '--format', 'json'])))).version, 'COMPOSE_UNAVAILABLE');
        const store = new ServicePlanStore(path);
        store.inspect(configuration, expectedEngine);
        const resolved = await new ServiceArtifactResolver().resolve(configuration), composition = ServicePlanIdentity.graph(resolved.inventory.composition), origin = new URL(configuration.origin), port = Number(origin.port || (origin.protocol === 'https:' ? 443 : 80));
        Check.require(await new TcpTableProbe().available(port), 'PORT_UNAVAILABLE');
        const projectName = 'cordis-' + CanonicalJson.digest({ installationId: configuration.installationId, installationDirectory: path }).slice(0, 16);
        this.empty(context, projectName);
        resolved.pluginBindings.sort(ServicePlanningHost.byProvider);
        const recipe = resolved.recipe;
        for (const service of Object.values(recipe.services)) {
            service.depends_on?.sort();
            service.secrets?.sort();
            service.volumes?.sort(ServicePlanningHost.byMount);
        }
        const compositionGeneration = CanonicalJson.digest({ configuration, composition, expectedEngine, artifacts: resolved.artifacts }), changes: ServicePlan['changes'] = [], effects: ServicePlan['effects'] = [];
        for (const artifact of resolved.artifacts)
            effects.push({ kind: artifact.kind === 'package' ? 'stage-package' : 'stage-image', target: artifact.kind === 'package' ? artifact.name + '@' + artifact.version : artifact.reference });
        for (const reference of configuration.credentialReferences)
            effects.push({ kind: 'prepare-credential', target: reference });
        effects.push({ kind: 'create-network', target: projectName + '_default' });
        for (const name of Object.keys(recipe.volumes).sort())
            effects.push({ kind: 'create-volume', target: projectName + '_' + name });
        for (const service of composition.services) {
            let image: ServicePlan['artifacts'][number] | undefined;
            for (const candidate of resolved.inventory.images)
                if (candidate.id === service.definition.imageId)
                    for (const artifact of resolved.artifacts)
                        if (artifact.kind === 'image' && artifact.reference === candidate.reference)
                            image = artifact;
            Check.require(image, 'MISSING_IMAGE');
            changes.push({ serviceId: service.serviceId, kind: 'add', serviceGeneration: ServicePlanIdentity.service(service, image, configuration, expectedEngine), previousGeneration: null, requiredActions: [], affectedDependencies: [] });
            effects.push({ kind: 'configure-service', target: service.serviceId });
            if (configuration.runtimeState === 'running')
                effects.push({ kind: 'start-service', target: service.serviceId });
        }
        for (const helper of resolved.inventory.helpers?.helpers ?? [])
            effects.push({ kind: 'stage-helper', target: helper.id + '@' + helper.version });
        const payload = { ...(resolved.inventory.helpers ? { helpers: resolved.inventory.helpers } : {}), formatVersion: 3 as const, configuration, composition, compositionGeneration, configurationDigest: CanonicalJson.digest(configuration), releaseDigest: resolved.releaseDigest, recipeDigest: resolved.recipeDigest, lockDigest: resolved.lockDigest, recipe, pluginBindings: resolved.pluginBindings, expectedEngine, expectedComposition: null, expectedResourceSet: null, retainedResources: [], changes, projectName, artifacts: resolved.artifacts, effects, blockers: [] }, digest = CanonicalJson.digest(payload), plan = ServiceSchemas.plan.parse({ ...payload, id: 'plan-' + digest, digest });
        return store.publish(plan);
    }
    private empty(context: string, project: string): void {
        for (const args of [['ps', '--all', '--format', '{{json .}}'], ['network', 'ls', '--format', '{{json .}}'], ['volume', 'ls', '--format', '{{json .}}']]) {
            const output = this.execute(['--context', context, ...args]);
            for (const line of output.split('\n')) {
                if (!line.trim())
                    continue;
                const value = StrictJson.object(StrictJson.parse(Buffer.from(line))), name = value.Name ?? value.Names ?? '', labels = value.Labels ?? '';
                Check.require(typeof name === 'string' && typeof labels === 'string', 'INVALID_ENGINE_RESPONSE');
                Check.require(name !== project && !name.startsWith(project + '_') && !name.startsWith(project + '-') && !labels.includes('com.docker.compose.project=' + project), 'FOREIGN_RUNTIME');
            }
        }
    }
    private static byPlugin(a: {
        id: string;
    }, b: {
        id: string;
    }): number { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }
    private static byProvider(a: {
        id: string;
        target: string;
    }, b: {
        id: string;
        target: string;
    }): number { return ServicePlanningHost.byPlugin({ id: a.target + ':' + a.id }, { id: b.target + ':' + b.id }); }
    private static byMount(a: {
        target: string;
    }, b: {
        target: string;
    }): number { return a.target < b.target ? -1 : a.target > b.target ? 1 : 0; }
}
/** Format-selected journal, using the existing publisher and installation writer. */
export class ServicePlanStore {
    readonly path: string;
    constructor(path: string) { this.path = resolve(path); }
    static isFormat(path: string): boolean {
        let root: SafeDirectory | null = null;
        try {
            root = SafeDirectory.open(path);
            return StrictJson.object(StrictJson.parse(root.file('.cordis/installation.json', undefined, 4 * 1024 * 1024, true))).formatVersion === 3;
        }
        catch {
            return false;
        }
        finally {
            root?.close();
        }
    }
    private anchor(): {
        directory: SafeDirectory;
        missing: string[];
    } {
        let path = this.path;
        const missing: string[] = [];
        while (true) {
            try {
                lstatSync(path);
                break;
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw error;
                missing.unshift(basename(path));
                const parent = dirname(path);
                Check.require(parent !== path, 'UNSAFE_PATH');
                path = parent;
            }
        }
        const directory = SafeDirectory.open(path);
        try {
            const stat = fstatSync(directory.fd);
            Check.require(stat.uid === process.getuid?.() && (stat.mode & 0o300) === 0o300, 'STORAGE_PERMISSION');
            return { directory, missing };
        }
        catch (error) {
            directory.close();
            throw error;
        }
    }
    private scope(plan: ServicePlan): void { const { id, digest, ...payload } = plan; Check.require(plan.configuration.installationDirectory === this.path && plan.configuration.installationDirectory === resolve(plan.configuration.installationDirectory) && id === 'plan-' + digest && CanonicalJson.digest(payload) === digest, 'PLAN_BINDING'); Check.require(plan.configurationDigest === CanonicalJson.digest(plan.configuration) && plan.releaseDigest === plan.configuration.release.manifestDigest && plan.recipeDigest !== null, 'PLAN_BINDING'); Check.require(plan.projectName === 'cordis-' + CanonicalJson.digest({ installationId: plan.configuration.installationId, installationDirectory: this.path }).slice(0, 16), 'PLAN_BINDING'); Check.require((plan.expectedComposition === null) === (plan.expectedResourceSet === null) && (plan.expectedComposition !== null || plan.retainedResources.length === 0), 'PLAN_BINDING'); Check.require(plan.compositionGeneration === CanonicalJson.digest({ configuration: plan.configuration, composition: plan.composition, expectedEngine: plan.expectedEngine, artifacts: plan.artifacts }), 'PLAN_BINDING'); }
    private parse(bytes: Buffer): ServicePlan { const result = ServiceSchemas.plan.safeParse(StrictJson.parse(bytes)); Check.require(result.success, 'INVALID_PLAN'); this.scope(result.data); return result.data; }
    inspect(configuration?: ServicePlan['configuration'], engine?: ServicePlan['expectedEngine']): boolean {
        const anchor = this.anchor();
        try {
            if (anchor.missing.length || anchor.directory.entries().length === 0)
                return false;
            Check.require(anchor.directory.entries().join(',') === '.cordis', 'FOREIGN_INSTALLATION');
            const state = anchor.directory.directory('.cordis', true);
            try {
                const entries = state.entries();
                if (!entries.includes('installation.json')) {
                    new PlanStore(this.path).inspect();
                    Check.block('MIGRATION_REQUIRED');
                }
                const value = StrictJson.parse(state.file('installation.json', undefined, 4 * 1024 * 1024, true)), object = StrictJson.object(value);
                if (object.formatVersion === 2) {
                    new InstallationStore(this.path).inspect();
                    Check.block('MIGRATION_REQUIRED');
                }
                const parsed = ServiceSchemas.receipt.safeParse(value);
                Check.require(parsed.success, 'INVALID_JOURNAL');
                const receipt = parsed.data;
                Check.require(receipt.ownerUid === process.getuid?.() && receipt.installationDirectory === this.path, 'FOREIGN_INSTALLATION');
                Check.require(receipt.migration === null, 'MIGRATION_NOT_QUALIFIED');
                if (configuration)
                    Check.require(configuration.installationId === receipt.installationId, 'FOREIGN_INSTALLATION');
                if (engine)
                    Check.require(CanonicalJson.stringify(engine) === CanonicalJson.stringify(receipt.expectedEngine), 'ENGINE_IDENTITY_CHANGED');
                for (const name of entries)
                    Check.require(['installation.json', 'plans', 'writer.lock', 'applications', 'resources', 'snapshots', 'artifacts', 'credentials', 'run', 'control'].includes(name), 'INCOMPLETE_JOURNAL');
                for (const name of ['artifacts', 'credentials', 'run', 'control'])
                    if (entries.includes(name)) {
                        const directory = state.directory(name, true);
                        try {
                            if (name === 'run' || name === 'control') {
                                const expected = name === 'run' ? 'host.sock' : 'worker.sock';
                                for (const entry of directory.entries()) {
                                    Check.require(entry === expected, 'INCOMPLETE_JOURNAL');
                                    const stat = lstatSync(directory.childPath(entry));
                                    Check.require(stat.isSocket() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600, 'WORKER_SOCKET_OWNER');
                                }
                            }
                        }
                        finally {
                            directory.close();
                        }
                    }
                if (entries.includes('writer.lock')) {
                    const writer = state.directory('writer.lock', true);
                    try {
                        Check.require(writer.entries().join(',') === 'owner.json', 'WRITER_CONFLICT');
                        const owner = StrictJson.object(StrictJson.parse(writer.file('owner.json', undefined, 1024, true)));
                        Check.require(Object.keys(owner).sort().join(',') === 'nonce,ownerUid,pid' && owner.ownerUid === process.getuid?.() && typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.nonce === 'string' && /^[a-f0-9-]{36}$/.test(owner.nonce), 'WRITER_CONFLICT');
                    }
                    finally {
                        writer.close();
                    }
                }
                const plans = state.directory('plans', true);
                try {
                    const allPlans = new Map<string, ServicePlan>();
                    const names = plans.entries();
                    Check.require(names.length > 0 && names.length <= 10000, 'INCOMPLETE_JOURNAL');
                    for (const name of names) {
                        Check.require(/^plan-[a-f0-9]{64}\.json$/.test(name), 'INCOMPLETE_JOURNAL');
                        const plan = this.parse(plans.file(name, undefined, 4 * 1024 * 1024, true));
                        Check.require(name === plan.id + '.json' && plan.configuration.installationId === receipt.installationId && CanonicalJson.stringify(plan.expectedEngine) === CanonicalJson.stringify(receipt.expectedEngine), 'FOREIGN_INSTALLATION');
                        allPlans.set(plan.id, plan);
                    }
                    new ServiceJournal(state, allPlans).read();
                    plans.verify();
                    state.verify();
                    anchor.directory.verify();
                    return true;
                }
                finally {
                    plans.close();
                }
            }
            finally {
                state.close();
            }
        }
        finally {
            anchor.directory.close();
        }
    }
    read(id: string, digest: string): ServicePlan {
        Check.require(/^plan-[a-f0-9]{64}$/.test(id) && id === 'plan-' + digest, 'PLAN_IDENTITY');
        Check.require(this.inspect(), 'MISSING_JOURNAL');
        const root = SafeDirectory.open(this.path);
        try {
            const plans = root.directory('.cordis/plans', true);
            try {
                const plan = this.parse(plans.file(id + '.json', undefined, 4 * 1024 * 1024, true));
                Check.require(plan.id === id && plan.digest === digest, 'PLAN_IDENTITY');
                return plan;
            }
            finally {
                plans.close();
            }
        }
        finally {
            root.close();
        }
    }
    publish(value: ServicePlan, heldWriter?: InstallationWriter): ServicePlan {
        const plan = ServiceSchemas.plan.parse(value);
        this.scope(plan);
        Check.require(Buffer.byteLength(CanonicalJson.stringify(plan)) < 4 * 1024 * 1024, 'PLAN_TOO_LARGE');
        const exists = this.inspect(plan.configuration, plan.expectedEngine);
        if (heldWriter)
            heldWriter.assert(this.path);
        if (exists) {
            const current = this.current();
            Check.require((current?.compositionGeneration ?? null) === plan.expectedComposition && (current ? CanonicalJson.digest(current.resources) : null) === plan.expectedResourceSet, 'STALE_GENERATION');
        }
        const anchor = this.anchor();
        let installation = anchor.directory;
        try {
            for (const part of anchor.missing) {
                mkdirSync(installation.childPath(part), { mode: 0o700 });
                fsyncSync(installation.fd);
                const child = installation.directory(part, true);
                if (installation !== anchor.directory)
                    installation.close();
                installation = child;
            }
            if (!exists) {
                Check.require(installation.entries().length === 0, 'INITIALIZATION_CONFLICT');
                const state = InstallationStore.mkdir(installation, '.cordis');
                try {
                    const plans = InstallationStore.mkdir(state, 'plans');
                    try {
                        InstallationStore.publish(plans, plan.id + '.json', plan);
                    }
                    finally {
                        plans.close();
                    }
                    InstallationStore.publish(state, 'installation.json', ServiceSchemas.receipt.parse({ formatVersion: 3, installationId: plan.configuration.installationId, installationDirectory: this.path, ownerUid: process.getuid!(), expectedEngine: plan.expectedEngine, migration: null }));
                }
                finally {
                    state.close();
                }
            }
            else {
                const state = installation.directory('.cordis', true), writer = heldWriter ?? new InstallationWriter(state);
                try {
                    writer.assert(this.path);
                    const plans = installation.directory('.cordis/plans', true);
                    try {
                        InstallationStore.publish(plans, plan.id + '.json', plan);
                    }
                    finally {
                        plans.close();
                    }
                }
                finally {
                    if (!heldWriter)
                        writer.close();
                    else
                        state.close();
                }
            }
        }
        finally {
            if (installation !== anchor.directory)
                installation.close();
            anchor.directory.close();
        }
        return this.read(plan.id, plan.digest);
    }
    private openJournal(): {
        root: SafeDirectory;
        state: SafeDirectory;
        journal: ServiceJournal;
    } { Check.require(this.inspect(), 'MISSING_JOURNAL'); const root = SafeDirectory.open(this.path); let state: SafeDirectory | undefined; try {
        state = root.directory('.cordis', true);
        const plansDirectory = state.directory('plans', true), plans = new Map<string, ServicePlan>();
        try {
            for (const name of plansDirectory.entries()) {
                const plan = this.parse(plansDirectory.file(name, undefined, 4 * 1024 * 1024, true));
                plans.set(plan.id, plan);
            }
        }
        finally {
            plansDirectory.close();
        }
        return { root, state, journal: new ServiceJournal(state, plans) };
    }
    catch (error) {
        state?.close();
        root.close();
        throw error;
    } }
    private closeJournal(scope: {
        root: SafeDirectory;
        state: SafeDirectory;
    }): void { scope.state.close(); scope.root.close(); }
    writer(): InstallationWriter { const scope = this.openJournal(); try {
        Check.require(!scope.state.entries().includes('run') && !scope.state.entries().includes('control'), 'WORKER_REPAIR_REQUIRED');
        return new InstallationWriter(scope.state);
    }
    catch (error) {
        scope.state.close();
        throw error;
    }
    finally {
        scope.root.close();
    } }
    records(): ServiceApplicationRecord[] { const scope = this.openJournal(); try {
        return scope.journal.read().records;
    }
    finally {
        this.closeJournal(scope);
    } }
    resources(): ServiceResourceReceipt[] { const scope = this.openJournal(); try {
        return scope.journal.read().resources;
    }
    finally {
        this.closeJournal(scope);
    } }
    current(): ServiceSnapshot | null { const scope = this.openJournal(); try {
        return scope.journal.read().current;
    }
    finally {
        this.closeJournal(scope);
    } }
    accept(request: Extract<ServiceWorkerRequest, {
        operation: 'submit';
    }>, writer: InstallationWriter): {
        record: ServiceApplicationRecord;
        fresh: boolean;
    } { const scope = this.openJournal(); try {
        return scope.journal.accept(request, writer);
    }
    finally {
        this.closeJournal(scope);
    } }
    append(record: ServiceApplicationRecord, writer: InstallationWriter): void { const scope = this.openJournal(); try {
        scope.journal.append(record, writer);
    }
    finally {
        this.closeJournal(scope);
    } }
    saveResource(receipt: ServiceResourceReceipt, writer: InstallationWriter): void { const scope = this.openJournal(); try {
        scope.journal.saveResource(receipt, writer);
    }
    finally {
        this.closeJournal(scope);
    } }
    saveSnapshot(snapshot: ServiceSnapshot, writer: InstallationWriter): void { const scope = this.openJournal(); try {
        scope.journal.saveSnapshot(snapshot, writer);
    }
    finally {
        this.closeJournal(scope);
    } }
    directory(name: 'artifacts' | 'credentials' | 'run' | 'control', writer?: InstallationWriter): SafeDirectory { const scope = this.openJournal(); try {
        if (scope.state.entries().includes(name))
            return scope.state.directory(name, true);
        Check.require(writer, 'MISSING_JOURNAL');
        writer.assert(this.path);
        return InstallationStore.mkdir(scope.state, name);
    }
    finally {
        this.closeJournal(scope);
    } }
}

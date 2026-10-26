import{AssetConfigurationRestart}from'./service-asset-restart.js';
import{MigrationCustody}from'./migration-custody.js';
import {PluginRequestJournal} from './plugin-registry.js';
import { PreparedServiceRelease } from './prepared-release.js';
import type { InstallationAuthority } from './service-authority.js';
import { ServiceJournal } from './service-journal.js';
import { BootstrapRecords, BootstrapPermit } from './service-bootstrap.js';
import { type ServiceApplicationRecord, type ServiceResourceReceipt, type ServiceSnapshot, type ServiceWorkerRequest } from '@treeseed-cordis/sdk';
import { lstatSync, fstatSync, mkdirSync, fsyncSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { InstallationStore, InstallationWriter } from './installed.js';
import { PlanStore } from './filesystem.js';
import { resolve } from 'node:path';
import { ServiceSchemas, PlatformSchemas, CanonicalJson, type ServicePlan, type ServiceInstance, type ServiceGraph } from '@treeseed-cordis/sdk';
import type { DiagnosticCommands, DiagnosticSystem } from './diagnose.js';
import { TcpTableProbe } from './host-system.js';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';
import { ServiceRuntimeInspection } from './service-engine.js';
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
/** Data-only classification; artifact validity and actual resources remain independently verified. */
export class ServiceTransitions {
    static initial(base: ServicePlan, candidate: Pick<ServicePlan, 'configuration' | 'expectedEngine' | 'composition' | 'helpers' | 'acquisitionPolicy'>): void { Check.require(candidate.configuration.installationId===base.configuration.installationId&&candidate.configuration.installationDirectory===base.configuration.installationDirectory&&candidate.configuration.origin===base.configuration.origin&&candidate.configuration.runtimeState===base.configuration.runtimeState&&CanonicalJson.stringify(candidate.expectedEngine)===CanonicalJson.stringify(base.expectedEngine),'PLAN_BINDING'); Check.require(CanonicalJson.stringify(candidate.composition.profile)===CanonicalJson.stringify(base.composition.profile)&&CanonicalJson.stringify(candidate.composition.worker)===CanonicalJson.stringify(base.composition.worker)&&CanonicalJson.stringify(candidate.helpers??null)===CanonicalJson.stringify(base.helpers??null)&&CanonicalJson.stringify(candidate.acquisitionPolicy??null)===CanonicalJson.stringify(base.acquisitionPolicy??null),'ROOT_TRANSITION_REQUIRED'); }
    static additive(plan:ServicePlan,restartServices?:string[]):void{Check.require(restartServices===undefined,'RESTART_SCOPE_NOT_QUALIFIED');for(const change of plan.changes)Check.require((change.kind==='add'||change.kind==='retain')&&change.requiredActions.length===0,'TRANSITION_ACTION_REQUIRED');}
    static activation(plan:ServicePlan,restartServices?:string[],previous?:ServicePlan):void{
        const required:string[]=[];for(const change of plan.changes){if((change.kind==='add'||change.kind==='retain')&&change.requiredActions.length===0)continue;if(change.kind==='reconfigure'&&change.requiredActions.length===0&&previous){const old=previous.composition.services.find(this.named.bind(null,change.serviceId)),next=plan.composition.services.find(this.named.bind(null,change.serviceId));Check.require(old&&next&&this.live(previous,plan,old,next),'TRANSITION_ACTION_REQUIRED');continue;}Check.require((change.kind==='replace'||change.kind==='reconfigure')&&CanonicalJson.stringify(change.requiredActions)==='["restart"]','TRANSITION_ACTION_REQUIRED');required.push(change.serviceId);}
        required.sort();if(required.length===0){Check.require(restartServices===undefined,'RESTART_SCOPE_NOT_QUALIFIED');return;}Check.require(restartServices!==undefined,'TRANSITION_ACTION_REQUIRED');Check.require(plan.expectedComposition!==null&&CanonicalJson.stringify([...restartServices].sort())===CanonicalJson.stringify(required),'RESTART_SCOPE_MISMATCH');
        if(previous)for(const id of required){const old=previous.composition.services.find(this.named.bind(null,id)),next=plan.composition.services.find(this.named.bind(null,id));Check.require(old&&next&&old.transitionPolicy.stateVersion===next.transitionPolicy.stateVersion&&AssetConfigurationRestart.compatible(previous,plan,old,next)&&CanonicalJson.stringify(old.definition.volumes)===CanonicalJson.stringify(next.definition.volumes)&&CanonicalJson.stringify(old.definition.secrets)===CanonicalJson.stringify(next.definition.secrets)&&old.definition.workerSocket===next.definition.workerSocket,'RESOURCE_MIGRATION_REQUIRED');}
    }
    static retained(previous:ServicePlan,desired:ServicePlan,resources:ServicePlan['retainedResources']):ServicePlan['retainedResources']{const result:ServicePlan['retainedResources']=[],changes=this.plan(previous,desired);for(const resource of resources){const change=resource.serviceId===null?undefined:changes.find(this.named.bind(null,resource.serviceId));if(!change||!['replace','retire'].includes(change.kind)){result.push(resource);continue;}const old=previous.composition.services.find(this.named.bind(null,resource.serviceId!)),next=desired.composition.services.find(this.named.bind(null,resource.serviceId!));if(change.kind==='replace'&&resource.kind!=='container'&&CanonicalJson.stringify(change.requiredActions)==='["restart"]'&&old&&next&&AssetConfigurationRestart.compatible(previous,desired,old,next)&&(resource.kind!=='configuration'||CanonicalJson.stringify(old.resources)===CanonicalJson.stringify(next.resources)))result.push(resource);}return result;}
    static plan(previous: ServicePlan, desired: ServicePlan): ServicePlan['changes'] {
        Check.require(previous.configuration.installationId===desired.configuration.installationId&&previous.configuration.installationDirectory===desired.configuration.installationDirectory&&previous.configuration.origin===desired.configuration.origin&&CanonicalJson.stringify(previous.expectedEngine)===CanonicalJson.stringify(desired.expectedEngine),'TRANSITION_SCOPE');
        Check.require(previous.composition.profile.id===desired.composition.profile.id&&previous.composition.profile.version===desired.composition.profile.version&&previous.composition.profile.workerSocketServiceId===desired.composition.profile.workerSocketServiceId,'PROFILE_MIGRATION_REQUIRED');
        Check.require(previous.configuration.runtimeState===desired.configuration.runtimeState,'RUNTIME_STATE_TRANSITION_UNSUPPORTED');Check.require(this.worker(previous)===this.worker(desired),'HOST_RESTART_REQUIRED');
        const result:ServicePlan['changes']=[],seen=new Set<string>();
        for(const service of desired.composition.services){seen.add(service.serviceId);const prior=previous.composition.services.find(this.named.bind(null,service.serviceId)),generation=this.generation(desired,service),old=prior?this.generation(previous,prior):null;let kind:ServicePlan['changes'][number]['kind']='add',requiredActions:ServicePlan['changes'][number]['requiredActions']=[];
            if(prior){if(old===generation)kind='retain';else{kind=this.physical(previous,prior)===this.physical(desired,service)?'reconfigure':'replace';requiredActions=prior.transitionPolicy.stateVersion!==service.transitionPolicy.stateVersion?['migration']:kind==='reconfigure'&&this.live(previous,desired,prior,service)?[]:['restart'];}}
            result.push({serviceId:service.serviceId,kind,serviceGeneration:generation,previousGeneration:old,requiredActions,affectedDependencies:kind==='retain'?[]:this.affected(desired,service.serviceId)});
        }
        for(const service of previous.composition.services)if(!seen.has(service.serviceId)){const generation=this.generation(previous,service);result.push({serviceId:service.serviceId,kind:'retire',serviceGeneration:generation,previousGeneration:generation,requiredActions:['removal-unsupported'],affectedDependencies:this.affected(previous,service.serviceId)});}
        return result.sort(this.order);
    }
    private static live(previous:ServicePlan,desired:ServicePlan,old:ServiceInstance,next:ServiceInstance):boolean{if(this.physical(previous,old)!==this.physical(desired,next)||CanonicalJson.stringify(previous.acquisitionPolicy??null)!==CanonicalJson.stringify(desired.acquisitionPolicy??null))return false;const{provider:before,...left}=old.readiness,{provider:after,...right}=next.readiness;if(CanonicalJson.stringify(before)===CanonicalJson.stringify(after)||CanonicalJson.stringify(left)!==CanonicalJson.stringify(right))return false;for(const grant of previous.acquisitionPolicy?.liveTransitions??[])if(grant.capability==='probe.service'&&grant.target==='deployment'&&before.target===grant.target&&after.target===grant.target&&grant.previousProviderId===before.providerId&&grant.nextProviderId===after.providerId&&grant.stateVersion===old.transitionPolicy.stateVersion&&grant.stateVersion===next.transitionPolicy.stateVersion&&this.artifact(before,grant.previous)&&this.artifact(after,grant.next))return true;return false;}
    private static artifact(reference:ServiceInstance['provider'],artifact:{package:string;version:string;integrity:string}):boolean{return reference.package.name===artifact.package&&reference.package.version===artifact.version&&reference.package.sha256===artifact.integrity;}
    private static worker(plan:ServicePlan):string{const {path,...identity}=plan.composition.worker;return CanonicalJson.stringify(identity);}
    private static named(id:string,value:{serviceId:string}):boolean{return value.serviceId===id;}
    private static order(a:{serviceId:string},b:{serviceId:string}):number{return a.serviceId<b.serviceId?-1:a.serviceId>b.serviceId?1:0;}
    private static image(plan:ServicePlan,service:ServiceInstance):Extract<ServicePlan['artifacts'][number],{kind:'image'}>{const reference=plan.recipe.services[service.serviceId]?.image;for(const artifact of plan.artifacts)if(artifact.kind==='image'&&artifact.reference===reference)return artifact;return Check.block('MISSING_IMAGE');}
    private static generation(plan:ServicePlan,service:ServiceInstance):string{return ServicePlanIdentity.service(service,this.image(plan,service),plan.configuration,plan.expectedEngine);}
    private static physical(plan:ServicePlan,service:ServiceInstance):string{const {readiness,...physical}=service;return CanonicalJson.digest({service:physical,image:this.image(plan,service)});}
    private static affected(plan:ServicePlan,id:string):string[]{const selected=new Set([id]);let progress=true;while(progress){progress=false;for(const consumer of plan.composition.services){if(selected.has(consumer.serviceId))continue;let affected=selected.has(consumer.readiness.endpoint.serviceId);for(const dependency of consumer.dependencies)for(const source of plan.composition.services)if(selected.has(source.serviceId))for(const binding of source.bindings)if(binding.bindingId===dependency.bindingId)affected=true;if(affected){selected.add(consumer.serviceId);progress=true;}}}selected.delete(id);return [...selected].sort();}
}
/** First format-3 plan-only slice; all activation remains behind the durable worker. */
export class ServicePlanningHost {
    constructor(private readonly commands: DiagnosticCommands, private readonly system: DiagnosticSystem, private readonly custody?: {previous:ServicePlan;writer:InstallationWriter;authority?:InstallationAuthority}) { }
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
        const overlaps = path === bundle || path.startsWith(bundle + '/') || bundle.startsWith(path + '/');
        if (overlaps) { Check.require(this.custody?.authority && this.custody.authority.writer === this.custody.writer, 'OVERLAPPING_STORAGE'); await PreparedServiceRelease.authorize(configuration, this.custody.previous, this.custody.authority); }
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
        const exists=store.inspect(configuration, expectedEngine);
        if(exists)for(const record of store.records()){Check.require(!record.recovery,'APPLICATION_RECOVERY_REQUIRED');Check.require(['completed','failed','cancelled'].includes(record.phase),'APPLICATION_BUSY');}
        const resolved = await new ServiceArtifactResolver().resolve(configuration), composition = ServicePlanIdentity.graph(resolved.inventory.composition), origin = new URL(configuration.origin), port = Number(origin.port || (origin.protocol === 'https:' ? 443 : 80));
        const current=exists?store.current():null;
        if(this.custody){this.custody.writer.assert(path);Check.require(CanonicalJson.stringify(store.read(this.custody.previous.id,this.custody.previous.digest))===CanonicalJson.stringify(this.custody.previous),'PLAN_BINDING');}
        if(current){Check.require(this.custody&&this.custody.previous.compositionGeneration===current.compositionGeneration,'OWNER_HOST_REQUIRED');await new ServiceRuntimeInspection(this.custody.previous).audit();}else if(this.custody){Check.require(store.records().length===0&&store.resources().length===0,'WORKER_REPAIR_REQUIRED');}
        if(!current&&this.custody) ServiceTransitions.initial(this.custody.previous,{configuration,expectedEngine,composition,helpers:resolved.inventory.helpers,acquisitionPolicy:resolved.inventory.acquisitionPolicy});
        if(!current)Check.require(await new TcpTableProbe().available(port), 'PORT_UNAVAILABLE');
        const projectName = 'cordis-' + CanonicalJson.digest({ installationId: configuration.installationId, installationDirectory: path }).slice(0, 16);
        if(!current)this.empty(context, projectName);
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
        const payload = { ...(resolved.inventory.acquisitionPolicy?{acquisitionPolicy:resolved.inventory.acquisitionPolicy}:{}), ...(Object.keys(resolved.runtimeBindings).length ? {runtimeBindings: resolved.runtimeBindings} : {}), ...(resolved.inventory.helpers ? { helpers: resolved.inventory.helpers } : {}), formatVersion: 3 as const, configuration, composition, compositionGeneration, configurationDigest: CanonicalJson.digest(configuration), releaseDigest: resolved.releaseDigest, recipeDigest: resolved.recipeDigest, lockDigest: resolved.lockDigest, recipe, pluginBindings: resolved.pluginBindings, expectedEngine, expectedComposition: current?.compositionGeneration??null, expectedResourceSet: current?CanonicalJson.digest(current.resources):null, retainedResources: current?.resources??[], changes, projectName, artifacts: resolved.artifacts, effects, blockers: [] }, digest = CanonicalJson.digest(payload), plan = ServiceSchemas.plan.parse({ ...payload, id: 'plan-' + digest, digest });
        if(current&&this.custody){
            const transitions=ServiceTransitions.plan(this.custody.previous,plan),changed=new Set<string>(),physical=new Set<string>();for(const change of transitions){if(change.kind!=='retain')changed.add(change.serviceId);if(change.kind==='add'||change.kind==='replace')physical.add(change.serviceId);}
            const wantedVolumes=new Set<string>();for(const service of plan.composition.services)if(physical.has(service.serviceId))for(const slot of service.resources.volumes)wantedVolumes.add(plan.projectName+'_r-'+CanonicalJson.digest({serviceId:service.serviceId,slot}).slice(0,48));const existingVolumes=new Set<string>();for(const receipt of store.resources())if(receipt.kind==='volume')existingVolumes.add(receipt.name);
            const retainedResources=ServiceTransitions.retained(this.custody.previous,plan,current.resources);
            const nextEffects:ServicePlan['effects']=[];for(const effect of effects){if(effect.kind==='create-network')continue;if(effect.kind==='create-volume'&&(!wantedVolumes.has(effect.target)||existingVolumes.has(effect.target)))continue;if(effect.kind==='prepare-credential'&&!physical.has(effect.target.slice('secret://'.length).split('/')[0]!))continue;if(effect.kind==='start-service'&&!physical.has(effect.target))continue;if(effect.kind==='configure-service'&&!changed.has(effect.target))continue;nextEffects.push(effect);}
            const nextPayload={...payload,changes:transitions,retainedResources,effects:nextEffects},nextDigest=CanonicalJson.digest(nextPayload);return store.publish(ServiceSchemas.plan.parse({...nextPayload,id:'plan-'+nextDigest,digest:nextDigest}),this.custody.writer);
        }
        return store.publish(plan,this.custody?.writer);
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
                    Check.require(!entries.includes(MigrationCustody.directory),'MIGRATION_REPAIR_REQUIRED');
                    new PlanStore(this.path).inspect();
                    Check.block('MIGRATION_REQUIRED');
                }
                const value = StrictJson.parse(state.file('installation.json', undefined, 4 * 1024 * 1024, true)), object = StrictJson.object(value);
                if (object.formatVersion === 2) {
                    Check.require(!entries.includes(MigrationCustody.directory),'MIGRATION_REPAIR_REQUIRED');
                    new InstallationStore(this.path).inspect();
                    Check.block('MIGRATION_REQUIRED');
                }
                const parsed = ServiceSchemas.receipt.safeParse(value);
                Check.require(parsed.success, 'INVALID_JOURNAL');
                const receipt = parsed.data;
                Check.require(receipt.ownerUid === process.getuid?.() && receipt.installationDirectory === this.path, 'FOREIGN_INSTALLATION');
                if(receipt.migration!==null){MigrationCustody.read(this.path);if(configuration)Check.require(configuration.installationId===receipt.installationId,'FOREIGN_INSTALLATION');if(engine)Check.require(CanonicalJson.stringify(engine)===CanonicalJson.stringify(receipt.expectedEngine),'ENGINE_IDENTITY_CHANGED');return true;}
                if (configuration)
                    Check.require(configuration.installationId === receipt.installationId, 'FOREIGN_INSTALLATION');
                if (engine)
                    Check.require(CanonicalJson.stringify(engine) === CanonicalJson.stringify(receipt.expectedEngine), 'ENGINE_IDENTITY_CHANGED');
                for (const name of entries)
                    Check.require(['installation.json', 'plans', 'writer.lock', 'applications', 'resources', 'snapshots', 'artifacts', 'credentials', 'run', 'control', 'launch', 'worker', 'plugins'].includes(name), 'INCOMPLETE_JOURNAL');
                for (const name of ['artifacts', 'credentials', 'run', 'control'])
                    if (entries.includes(name)) {
                        const directory = state.directory(name, true);
                        try {
                            if (name === 'run' || name === 'control') {
                                const expected = name === 'run' ? 'host.sock' : 'worker.sock';
                                for (const entry of directory.entries()) {
                                    Check.require(entry === expected, 'INCOMPLETE_JOURNAL');
                                    const stat = lstatSync(directory.childPath(entry));
                                    Check.require(stat.isSocket() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600, 'WORKER_SOCKET_OWNER');
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
                    PluginRequestJournal.read(state, receipt);
                    BootstrapRecords.read(state, allPlans);
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
        return this.readPublished(id, digest);
    }
    /** Immutable record/scope read only. Never establishes mutable journal or runtime health. */
    readPublished(id: string, digest: string): ServicePlan {
        Check.require(/^plan-[a-f0-9]{64}$/.test(id) && id === 'plan-' + digest, 'PLAN_IDENTITY');
        const root = SafeDirectory.open(this.path);
        try {
            const state = root.directory('.cordis', true);
            try {
                const receipt = ServiceSchemas.receipt.safeParse(StrictJson.parse(state.file('installation.json', undefined, 4 * 1024 * 1024, true)));
                Check.require(receipt.success, 'INVALID_JOURNAL');
                Check.require(receipt.data.ownerUid === process.getuid?.() && receipt.data.installationDirectory === this.path, 'FOREIGN_INSTALLATION');
                Check.require(receipt.data.migration === null, 'MIGRATION_ACTIVATION_REQUIRED');
                const plans = state.directory('plans', true);
                try {
                    const plan = this.parse(plans.file(id + '.json', undefined, 4 * 1024 * 1024, true));
                    Check.require(plan.id === id && plan.digest === digest, 'PLAN_IDENTITY');
                    Check.require(plan.configuration.installationId === receipt.data.installationId && CanonicalJson.stringify(plan.expectedEngine) === CanonicalJson.stringify(receipt.data.expectedEngine), 'FOREIGN_INSTALLATION');
                    plans.verify(); state.verify(); root.verify();
                    return plan;
                } finally { plans.close(); }
            } finally { state.close(); }
        } finally { root.close(); }
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
    } {
        Check.require(this.inspect(), 'MISSING_JOURNAL');
        const root = SafeDirectory.open(this.path);
        let state: SafeDirectory | undefined;
        try {
            state = root.directory('.cordis', true);
            Check.require(ServiceSchemas.receipt.parse(StrictJson.parse(state.file('installation.json',undefined,4*1024*1024,true))).migration===null,'MIGRATION_ACTIVATION_REQUIRED');
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
        }
    }
    private closeJournal(scope: {
        root: SafeDirectory;
        state: SafeDirectory;
    }): void { scope.state.close(); scope.root.close(); }
    writer(permit?: BootstrapPermit): InstallationWriter {
        const scope = this.openJournal();
        try {
            Check.require(!scope.state.entries().includes('run') && !scope.state.entries().includes('control'), 'WORKER_REPAIR_REQUIRED');
            if (scope.state.entries().includes('launch')) {
                Check.require(permit instanceof BootstrapPermit, 'BOOTSTRAP_HANDOFF_REQUIRED');
                permit.authorize(this.path);
            }
            else
                Check.require(!permit, 'BOOTSTRAP_BINDING');
            return new InstallationWriter(scope.state);
        }
        catch (error) {
            scope.state.close();
            throw error;
        }
        finally {
            scope.root.close();
        }
    }
    /** Latest state per application, in request creation order; chronological events remain in the journal. */
    records(): ServiceApplicationRecord[] {
        const scope = this.openJournal();
        try {
            return scope.journal.read().records;
        }
        finally {
            this.closeJournal(scope);
        }
    }
    resources(): ServiceResourceReceipt[] {
        const scope = this.openJournal();
        try {
            return scope.journal.read().resources;
        }
        finally {
            this.closeJournal(scope);
        }
    }
    current(): ServiceSnapshot | null {
        const scope = this.openJournal();
        try {
            return scope.journal.read().current;
        }
        finally {
            this.closeJournal(scope);
        }
    }
    accept(request: Extract<ServiceWorkerRequest, {
        operation: 'submit';
    }>, writer: InstallationWriter): {
        record: ServiceApplicationRecord;
        fresh: boolean;
    } {
        const scope = this.openJournal();
        try {
            return scope.journal.accept(request, writer);
        }
        finally {
            this.closeJournal(scope);
        }
    }
    append(record: ServiceApplicationRecord, writer: InstallationWriter): void {
        const scope = this.openJournal();
        try {
            scope.journal.append(record, writer);
        }
        finally {
            this.closeJournal(scope);
        }
    }
    saveResource(receipt: ServiceResourceReceipt, writer: InstallationWriter): void {
        const scope = this.openJournal();
        try {
            scope.journal.saveResource(receipt, writer);
        }
        finally {
            this.closeJournal(scope);
        }
    }
    saveSnapshot(snapshot: ServiceSnapshot, writer: InstallationWriter): void {
        const scope = this.openJournal();
        try {
            scope.journal.saveSnapshot(snapshot, writer);
        }
        finally {
            this.closeJournal(scope);
        }
    }
    directory(name: 'artifacts' | 'credentials' | 'run' | 'control', writer?: InstallationWriter): SafeDirectory {
        const scope = this.openJournal();
        try {
            if (scope.state.entries().includes(name))
                return scope.state.directory(name, true);
            Check.require(writer, 'MISSING_JOURNAL');
            writer.assert(this.path);
            return InstallationStore.mkdir(scope.state, name);
        }
        finally {
            this.closeJournal(scope);
        }
    }
}

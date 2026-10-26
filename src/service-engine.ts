import { join } from 'node:path';
import {ServiceObserverMount} from './service-observer-mount.js';
import { CanonicalJson, ServiceSchemas, type ServicePlan, type ServiceInstance, type ServiceEngine, type ServiceExecutionContext, type ServiceDependency, type ServiceIdentity, type ServiceReadiness, type ServiceResourceReceipt } from '@treeseed-cordis/sdk';
import { ServicePlanStore } from './service-plan.js';
import { ServiceCredentials } from './service-credentials.js';
import { LocalDockerCommands, type ServiceImageCommands } from './service-images.js';
import { InstallationWriter } from './installed.js';
import { StrictJson, PlanningFailure as Check } from './filesystem.js';
export class RuntimeResources {
    static selected(store: ServicePlanStore,plan:ServicePlan): ServiceResourceReceipt[] {
        const versions=new Map<string,ServiceResourceReceipt>();for(const item of store.resources()){const prior=versions.get(item.resourceId);if(!prior||prior.references.length<item.references.length)versions.set(item.resourceId,item);}
        const result=new Map<string,ServiceResourceReceipt>(),current=new Set(store.current()?.resources.map(RuntimeResources.bindingId)??[]),record=store.records().at(-1),pending=record?.planId===plan.id&&record.digest===plan.digest&&['activate','readiness','commit'].includes(record.phase);
        for(const item of versions.values())if(current.has(item.resourceId))result.set(this.key(item),item);
        for(const item of versions.values())if(item.kind!=='container'&&item.references.includes(plan.compositionGeneration))result.set(this.key(item),item);
        if(pending)for(const item of versions.values())if(item.kind==='container'&&item.serviceId&&item.resourceId===this.containerId(plan,item.name,item.serviceId,item.definitionDigest))result.set(this.key(item),item);
        return [...result.values()];
    }
    private static key(value:ServiceResourceReceipt):string{return value.kind+':'+(value.serviceId??'')+':'+value.name;}
    static containerId(plan:ServicePlan,name:string,serviceId:string,definitionDigest:string):string{return CanonicalJson.digest({installationId:plan.configuration.installationId,installationDirectory:plan.configuration.installationDirectory,kind:'container',serviceId,name,definitionDigest,creatingPlanId:plan.id});}
    private static bindingId(value:{resourceId:string}):string{return value.resourceId;}
    static retiring(store:ServicePlanStore,plan:ServicePlan,receipt:ServiceResourceReceipt):boolean{if(receipt.kind!=='container'||!receipt.serviceId)return false;const record=store.records().at(-1);return record?.planId===plan.id&&record.digest===plan.digest&&record.phase==='activate'&&record.restartServices?.includes(receipt.serviceId)===true&&store.current()?.resources.some(RuntimeResources.resourceId.bind(null,receipt.resourceId))===true&&plan.changes.some(RuntimeResources.restartChange.bind(null,receipt.serviceId));}
    private static resourceId(id:string,value:{resourceId:string}):boolean{return value.resourceId===id;}
    private static restartChange(id:string,value:ServicePlan['changes'][number]):boolean{return value.serviceId===id&&(value.kind==='replace'||value.kind==='reconfigure')&&CanonicalJson.stringify(value.requiredActions)==='["restart"]';}
    static restart(store:ServicePlanStore,plan:ServicePlan,id:string):boolean{const record=store.records().at(-1);return record?.planId===plan.id&&record.digest===plan.digest&&record.phase==='activate'&&record.restartServices?.includes(id)===true&&plan.changes.some(RuntimeResources.restartChange.bind(null,id));}
    static async present(commands:ServiceImageCommands,plan:ServicePlan,receipt:ServiceResourceReceipt):Promise<boolean>{Check.require(receipt.actualId,'RESOURCE_IDENTITY');const output=await commands.run(plan.expectedEngine,['container','ls','--all','--no-trunc','--filter','id='+receipt.actualId,'--format','{{json .}}']);if(!output.trim())return false;const rows=output.trim().split('\n');Check.require(rows.length===1&&StrictJson.object(StrictJson.parse(Buffer.from(rows[0]!))).ID===receipt.actualId,'RESOURCE_IDENTITY_CHANGED');return true;}
    static service(plan: ServicePlan, id: string): ServiceInstance { for (const service of plan.composition.services)
        if (service.serviceId === id)
            return service; return Check.block('SERVICE_SCOPE'); }
    static labels(plan: ServicePlan, receipt: ServiceResourceReceipt): Record<string, string> { return { 'com.docker.compose.project': plan.projectName, 'ai.treeseed.cordis.installation': plan.configuration.installationId, 'ai.treeseed.cordis.directory': CanonicalJson.digest(plan.configuration.installationDirectory), 'ai.treeseed.cordis.resource': receipt.resourceId, 'ai.treeseed.cordis.definition': receipt.definitionDigest, 'ai.treeseed.cordis.generation': receipt.creatingGeneration }; }
    static physical(kind: string, object: Record<string, unknown>): string { if (kind === 'volume')
        return CanonicalJson.digest({ Name: object.Name, Driver: object.Driver, Mountpoint: object.Mountpoint, CreatedAt: object.CreatedAt, Scope: object.Scope }); Check.require(typeof object.Id === 'string' && /^[a-f0-9]{64}$/.test(object.Id), 'RESOURCE_IDENTITY'); return object.Id; }
    static checked(plan: ServicePlan, receipt: ServiceResourceReceipt, object: Record<string, unknown>): void { Check.require(this.physical(receipt.kind, object) === receipt.actualId, 'RESOURCE_IDENTITY_CHANGED'); const labels = StrictJson.object(receipt.kind === 'container' ? StrictJson.object(object.Config).Labels : object.Labels); for (const [key, value] of Object.entries(this.labels(plan, receipt)))
        Check.require(labels[key] === value, 'FOREIGN_RUNTIME'); if (receipt.kind === 'container') {
        const names = String(object.Name).replace(/^\//, '');
        Check.require(names === receipt.name && object.Image === 'sha256:' + receipt.imageDigest, 'RESOURCE_IDENTITY_CHANGED');
        const host = StrictJson.object(object.HostConfig);
        Check.require(host.Privileged === false && host.NetworkMode === plan.projectName + '_default', 'UNSAFE_RUNTIME');
        const service = RuntimeResources.service(plan, receipt.serviceId!); const observer = ServiceObserverMount.open(plan, service); try { observer?.mounted(object); } finally { observer?.close(); }
    }
    else
        Check.require(object.Name === receipt.name, 'RESOURCE_IDENTITY_CHANGED'); }
    static async inspect(commands: ServiceImageCommands, plan: ServicePlan, kind: string, name: string): Promise<Record<string, unknown>> { const result = StrictJson.parse(Buffer.from(await commands.run(plan.expectedEngine, [kind, 'inspect', name]))); Check.require(Array.isArray(result) && result.length === 1, 'RESOURCE_IDENTITY'); return StrictJson.object(result[0]); }
}
/** Read-only identity checks, also used before any new Docker effect. No readiness inference. */
export class ServiceRuntimeInspection {
    private readonly plan: ServicePlan;
    private readonly store: ServicePlanStore;
    constructor(plan: ServicePlan, private readonly commands: ServiceImageCommands = new LocalDockerCommands()) { this.plan = ServiceSchemas.plan.parse(plan); this.store = new ServicePlanStore(this.plan.configuration.installationDirectory); }
    async audit(): Promise<void> { await this.commands.verify(this.plan.expectedEngine); const receipts = RuntimeResources.selected(this.store,this.plan), known = new Map<string, ServiceResourceReceipt>(); for (const receipt of receipts)
        if (['container', 'network', 'volume'].includes(receipt.kind)) {
            Check.require(receipt.actualId, 'RESOURCE_IDENTITY');
            if(RuntimeResources.retiring(this.store,this.plan,receipt)&&!await RuntimeResources.present(this.commands,this.plan,receipt))continue;
            const object = await RuntimeResources.inspect(this.commands, this.plan, receipt.kind, receipt.name);
            RuntimeResources.checked(this.plan, receipt, object);
            known.set(receipt.kind + ':' + receipt.name, receipt);
        } for (const kind of ['container', 'network', 'volume']) {
        const args = kind === 'container' ? ['container', 'ls', '--all', '--no-trunc', '--format', '{{json .}}'] : [kind, 'ls', '--format', '{{json .}}'];
        const output = await this.commands.run(this.plan.expectedEngine, args);
        for (const line of output.split('\n')) {
            if (!line.trim())
                continue;
            const value = StrictJson.object(StrictJson.parse(Buffer.from(line))), name = value.Name ?? value.Names, labels = value.Labels;
            Check.require(typeof name === 'string' && typeof labels === 'string', 'INVALID_ENGINE_RESPONSE');
            if (name === this.plan.projectName || name.startsWith(this.plan.projectName + '_') || name.startsWith(this.plan.projectName + '-') || labels.includes('com.docker.compose.project=' + this.plan.projectName))
                Check.require(known.has(kind + ':' + name), 'FOREIGN_RUNTIME');
        }
    } await this.commands.verify(this.plan.expectedEngine); }
    async service(id: string, portId?: string, scheme?: 'http' | 'https' | 'tcp'): Promise<{
        running: boolean;
        endpoint: string;
        actualId: string;
    }> { const service = RuntimeResources.service(this.plan, id), port = service.definition.ports.find(ServiceRuntimeInspection.port.bind(null, portId ?? service.readiness.endpoint.portId)); Check.require(port, 'SERVICE_ENDPOINT'); let receipt: ServiceResourceReceipt | undefined; for (const item of RuntimeResources.selected(this.store,this.plan))
        if (item.kind === 'container' && item.serviceId === id) {
            Check.require(!receipt, 'AMBIGUOUS_RESOURCE');
            receipt = item;
        } Check.require(receipt?.actualId, 'MISSING_RESOURCE'); await this.commands.verify(this.plan.expectedEngine); const object = await RuntimeResources.inspect(this.commands, this.plan, 'container', receipt.name); RuntimeResources.checked(this.plan, receipt, object); const state = StrictJson.object(object.State); if (state.Running !== true)
        return { running: false, endpoint: '', actualId: receipt.actualId }; const network = StrictJson.object(StrictJson.object(StrictJson.object(object.NetworkSettings).Networks)[this.plan.projectName + '_default']), address = String(network.IPAddress); Check.require(/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address), 'SERVICE_ENDPOINT'); return { running: state.Running === true, endpoint: (scheme ?? service.readiness.scheme) + '://' + address + ':' + port.target + '/', actualId: receipt.actualId }; }
    private static port(id: string, value: {
        id: string;
    }): boolean { return id === value.id; }
}
/** Immutable per-instance context. Native Cordis supplies this adapter as service.context. */
export class ServiceExecution implements ServiceExecutionContext {
    private readonly graph: ServicePlan['composition'];
    private readonly selected: ServiceInstance;
    constructor(plan: ServicePlan, serviceId: string) { this.graph = ServiceSchemas.graph.parse(plan.composition); this.selected = RuntimeResources.service({ ...plan, composition: this.graph }, serviceId); }
    get service(): ServiceInstance { return structuredClone(this.selected); }
    dependency(port: string): ServiceDependency { let result: ServiceDependency | undefined; for (const dependency of this.selected.dependencies)
        if (dependency.port === port)
            for (const target of this.graph.services)
                for (const binding of target.bindings)
                    if (binding.bindingId === dependency.bindingId) {
                        Check.require(!result && binding.contractId === dependency.contractId && binding.contractVersion === dependency.contractVersion, 'SERVICE_BINDING_MISMATCH');
                        const endpoints: Record<string, string> = {};
                        for (const item of target.definition.ports)
                            endpoints[item.id] = target.serviceId + ':' + item.target;
                        result = { serviceId: target.serviceId, bindingId: binding.bindingId, contractId: binding.contractId, contractVersion: binding.contractVersion, endpoints };
                    } Check.require(result, 'SERVICE_BINDING_MISMATCH'); return structuredClone(result); }
}
/** Per-provider capability adapter; never exposes another service's authority. */
export class ScopedServiceEngine implements ServiceEngine {
    constructor(private readonly serviceId: string, private readonly engine: ServiceEngine) { }
    private check(id: string): void { Check.require(id === this.serviceId, 'SERVICE_SCOPE'); }
    start(id: string, definition: ServiceInstance['definition']): Promise<void> { this.check(id); return this.engine.start(id, definition); }
    ready(id: string): Promise<ServiceReadiness> { this.check(id); return this.engine.ready(id); }
    identity(id: string): ServiceIdentity { this.check(id); return this.engine.identity(id); }
}
/** Coherent bounded Docker actuator. Cordis, rather than this class, owns plugin lifetimes. */
export class ServiceContainerEngine implements ServiceEngine {
    private readonly plan: ServicePlan;
    private readonly store: ServicePlanStore;
    private readonly credentials: ServiceCredentials;
    constructor(plan: ServicePlan, private readonly writer: InstallationWriter, private readonly commands: ServiceImageCommands = new LocalDockerCommands()) { this.plan = ServiceSchemas.plan.parse(plan); this.store = new ServicePlanStore(this.plan.configuration.installationDirectory); this.credentials = new ServiceCredentials(this.plan); }
    private authority(): void { this.writer.assert(this.store.path); Check.require(CanonicalJson.stringify(this.store.read(this.plan.id, this.plan.digest)) === CanonicalJson.stringify(this.plan), 'PLAN_BINDING'); let active = false; for (const record of this.store.records())
        if (record.planId === this.plan.id && record.digest === this.plan.digest && record.phase === 'activate')
            active = true; Check.require(active, 'ACCEPTED_ACTIVATION_REQUIRED'); }
    private receipt(kind: ServiceResourceReceipt['kind'], name: string, serviceId: string | null, definitionDigest: string, imageDigest: string | null = null): ServiceResourceReceipt { const resourceId = CanonicalJson.digest({ installationId: this.plan.configuration.installationId, installationDirectory: this.store.path, kind, serviceId, name, definitionDigest }); return ServiceSchemas.resourceReceipt.parse({ formatVersion: 3, installationId: this.plan.configuration.installationId, installationDirectory: this.store.path, resourceId, kind, serviceId, name, creatingGeneration: this.plan.compositionGeneration, definitionDigest, references: [this.plan.compositionGeneration], actualId: null, contentDigest: null, imageDigest, path: null, ownerUid: process.getuid!(), legacy: null }); }
    private previous(candidate: ServiceResourceReceipt): ServiceResourceReceipt | undefined { let result: ServiceResourceReceipt | undefined; for (const receipt of RuntimeResources.selected(this.store,this.plan))
        if (receipt.kind === candidate.kind && receipt.name === candidate.name) {
            Check.require((receipt.resourceId === candidate.resourceId && receipt.definitionDigest === candidate.definitionDigest)||RuntimeResources.retiring(this.store,this.plan,receipt), 'RESOURCE_CHANGE_REQUIRES_ACTION');
            result = receipt;
        } return result; }
    private async stop(receipt:ServiceResourceReceipt,remove:boolean):Promise<void>{this.authority();Check.require(receipt.serviceId&&RuntimeResources.restart(this.store,this.plan,receipt.serviceId),'RESTART_SCOPE_MISMATCH');await new ServiceRuntimeInspection(this.plan,this.commands).audit();RuntimeResources.checked(this.plan,receipt,await RuntimeResources.inspect(this.commands,this.plan,'container',receipt.name));await this.commands.verify(this.plan.expectedEngine);await this.commands.run(this.plan.expectedEngine,['container','stop','--time','10',receipt.actualId!]);const stopped=await RuntimeResources.inspect(this.commands,this.plan,'container',receipt.name);RuntimeResources.checked(this.plan,receipt,stopped);Check.require(StrictJson.object(stopped.State).Running===false,'RESOURCE_STILL_RUNNING');this.authority();await this.commands.verify(this.plan.expectedEngine);if(remove)await this.commands.run(this.plan.expectedEngine,['container','rm',receipt.actualId!]);}
    private save(receipt: ServiceResourceReceipt): ServiceResourceReceipt { const references = [...receipt.references]; if (!references.includes(this.plan.compositionGeneration))
        references.push(this.plan.compositionGeneration); references.sort(); const value = { ...receipt, references }; this.writer.assert(this.store.path); this.store.saveResource(value, this.writer); return value; }
    private flags(receipt: ServiceResourceReceipt, observerDigest?: string): string[] { const args: string[] = []; for (const [key, value] of Object.entries(RuntimeResources.labels(this.plan, receipt)))
        args.push('--label', key + '=' + value); if (observerDigest) args.push('--label', 'ai.treeseed.cordis.observer=' + observerDigest); return args; }
    private async resource(candidate: ServiceResourceReceipt): Promise<ServiceResourceReceipt> { const previous = this.previous(candidate); if (previous) {
        RuntimeResources.checked(this.plan, previous, await RuntimeResources.inspect(this.commands, this.plan, previous.kind, previous.name));
        return this.save(previous);
    } this.authority(); await new ServiceRuntimeInspection(this.plan, this.commands).audit(); const args = [candidate.kind, 'create', ...this.flags(candidate), candidate.name]; if (candidate.kind === 'network')
        args.splice(2, 0, '--driver', 'bridge'); await this.commands.run(this.plan.expectedEngine, args); const object = await RuntimeResources.inspect(this.commands, this.plan, candidate.kind, candidate.name), receipt = { ...candidate, actualId: RuntimeResources.physical(candidate.kind, object) }; RuntimeResources.checked(this.plan, receipt, object); return this.save(receipt); }
    private image(service: ServiceInstance): {
        manifestDigest: string;
        dockerId: string;
    } { const source = this.plan.recipe.services[service.serviceId]; Check.require(source, 'SERVICE_RECIPE_MISMATCH'); let artifact: Extract<ServicePlan['artifacts'][number], {
        kind: 'image';
    }> | undefined; for (const candidate of this.plan.artifacts)
        if (candidate.kind === 'image' && candidate.reference === source.image)
            artifact = candidate; Check.require(artifact, 'MISSING_IMAGE'); const artifacts = this.store.directory('artifacts'); try {
        const record = StrictJson.object(StrictJson.parse(artifacts.file('images/' + artifact.manifestDigest + '/binding.json', undefined, 1024 * 1024, true)));
        Check.require(record.installationId === this.plan.configuration.installationId && record.installationDirectory === this.store.path && record.manifestDigest === artifact.manifestDigest && record.configDigest === artifact.configDigest && CanonicalJson.stringify(record.expectedEngine) === CanonicalJson.stringify(this.plan.expectedEngine) && typeof record.dockerId === 'string' && [artifact.manifestDigest, artifact.configDigest].includes(record.dockerId.slice(7)), 'IMAGE_IDENTITY_CHANGED');
        return { manifestDigest: artifact.manifestDigest, dockerId: record.dockerId };
    }
    finally {
        artifacts.close();
    } }
    private volumeName(serviceId: string, slot: string): string { return this.plan.projectName + '_r-' + CanonicalJson.digest({ serviceId, slot }).slice(0, 48); }
    private container(service: ServiceInstance): ServiceResourceReceipt { const image = this.image(service), mounts = []; for (const secret of service.definition.secrets)
        mounts.push({ target: secret.target, ...this.credentials.mount(service.serviceId, secret.slot) }); const candidate=this.receipt('container', this.plan.projectName + '_' + service.serviceId, service.serviceId, CanonicalJson.digest({ provider: service.provider, definition: service.definition, stateVersion: service.transitionPolicy.stateVersion, mounts, image, ...service.definition.workerSocket ? {observer: ServiceObserverMount.fingerprint(this.plan, service)} : {} }), image.dockerId.slice(7));for(const current of RuntimeResources.selected(this.store,this.plan))if(current.kind==='container'&&current.serviceId===service.serviceId&&current.name===candidate.name&&current.definitionDigest===candidate.definitionDigest)return {...candidate,resourceId:current.resourceId};return {...candidate,resourceId:RuntimeResources.containerId(this.plan,candidate.name,service.serviceId,candidate.definitionDigest)}; }
    identity(id: string): ServiceIdentity { const service = RuntimeResources.service(this.plan, id), change = this.plan.changes.find(ServiceContainerEngine.named.bind(null, id)); Check.require(change, 'SERVICE_SCOPE'); return { installationId: this.plan.configuration.installationId, serviceId: id, providerId: service.provider.providerId, serviceGeneration: change.serviceGeneration, resourceId: this.container(service).resourceId }; }
    async ready(id: string): Promise<ServiceReadiness> { RuntimeResources.service(this.plan, id); await new ServiceRuntimeInspection(this.plan, this.commands).service(id); return { serviceId: id, ready: false, observations: ['protocol-qualification-required'] }; }
    private static named(id: string, value: {
        serviceId: string;
    }): boolean { return id === value.serviceId; }
    private static port(id: string, value: {
        id: string;
    }): boolean { return id === value.id; }
    async start(id: string, definition: ServiceInstance['definition']): Promise<void> { this.authority(); const service = RuntimeResources.service(this.plan, id); Check.require(CanonicalJson.stringify(ServiceSchemas.definition.parse(definition)) === CanonicalJson.stringify(service.definition), 'SERVICE_RECIPE_MISMATCH'); Check.require(this.plan.configuration.runtimeState === 'running', 'STOPPED_ACTIVATION_UNSUPPORTED'); const observer = ServiceObserverMount.open(this.plan, service); try { await new ServiceRuntimeInspection(this.plan, this.commands).audit(); const image = this.image(service), metadata = await RuntimeResources.inspect(this.commands, this.plan, 'image', image.dockerId); Check.require(metadata.Id === image.dockerId && metadata.Os === 'linux' && metadata.Architecture === 'amd64', 'IMAGE_IDENTITY_CHANGED'); await this.resource(this.receipt('network', this.plan.projectName + '_default', null, CanonicalJson.digest({ driver: 'bridge', project: this.plan.projectName }))); for (const slot of service.resources.volumes)
        await this.resource(this.receipt('volume', this.volumeName(id, slot), id, CanonicalJson.digest({ slot, stateVersion: service.transitionPolicy.stateVersion }))); const candidate = this.container(service), previous = this.previous(candidate); if (previous) {
        RuntimeResources.checked(this.plan, previous, await RuntimeResources.inspect(this.commands, this.plan, 'container', previous.name));
        const restart=RuntimeResources.restart(this.store,this.plan,id);
        if(previous.resourceId!==candidate.resourceId){Check.require(restart,'RESOURCE_CHANGE_REQUIRES_ACTION');await this.stop(previous,true);}
        else{if(restart){await this.stop(previous,false);this.authority();await this.commands.run(this.plan.expectedEngine,['container','start',previous.actualId!]);}const state=await new ServiceRuntimeInspection(this.plan,this.commands).service(id);Check.require(state.running,'RESOURCE_STOPPED_REQUIRES_ACTION');this.save(previous);return;}
    } this.authority(); await new ServiceRuntimeInspection(this.plan, this.commands).audit(); const args = ['container', 'create', '--pull=never', '--name', candidate.name, '--network', this.plan.projectName + '_default', '--network-alias', id, '--security-opt', 'no-new-privileges:true', '--restart', 'unless-stopped', ...this.flags(candidate, observer?.digest)]; if (observer) args.push('--mount', observer.argument()); if (service.definition.user === 'installation-owner')
        args.push('--user', String(process.getuid!()) + ':0'); for (const [key, value] of Object.entries(service.definition.environment)) {
        let text: string;
        if (typeof value === 'string')
            text = value;
        else {
            const target = RuntimeResources.service(this.plan, value.serviceId), port = target.definition.ports.find(ServiceContainerEngine.port.bind(null, value.portId));
            Check.require(port, 'SERVICE_ENDPOINT');
            text = value.scheme + '://' + target.serviceId + ':' + port.target + value.path;
        }
        args.push('--env', key + '=' + text);
    } for (const volume of service.definition.volumes)
        args.push('--mount', 'type=volume,source=' + this.volumeName(id, volume.source) + ',target=' + volume.target + (volume.readOnly ? ',readonly' : '')); const anchor = this.store.directory(service.definition.secrets.length ? 'credentials' : 'artifacts'); try {
        for (const secret of service.definition.secrets) {
            const mount = this.credentials.mount(id, secret.slot);
            anchor.file(mount.path.slice('credentials/'.length), mount.contentDigest, 4 * 1024 * 1024, true);
            args.push('--mount', 'type=bind,source=' + join(anchor.path, mount.path.slice('credentials/'.length)) + ',target=' + secret.target + ',readonly');
        }
        for (const port of service.definition.ports)
            if (port.publication)
                args.push('--publish', (port.publication.host === '::1' ? '[::1]' : port.publication.host) + ':' + port.publication.port + ':' + port.target + '/tcp');
        args.push(image.dockerId, ...(service.definition.command ?? []));
        this.authority();
        await this.commands.verify(this.plan.expectedEngine);
        observer?.verify();
        await this.commands.run(this.plan.expectedEngine, args);
        observer?.verify();
        anchor.verify();
        for (const secret of service.definition.secrets)
            this.credentials.mount(id, secret.slot);
        const object = await RuntimeResources.inspect(this.commands, this.plan, 'container', candidate.name), receipt = { ...candidate, actualId: RuntimeResources.physical('container', object) };
        observer?.mounted(object, observer.source());
        RuntimeResources.checked(this.plan, receipt, object);
        this.save(receipt);
        this.authority();
        await this.commands.verify(this.plan.expectedEngine);
        observer?.verify();
        await this.commands.run(this.plan.expectedEngine, ['container', 'start', receipt.actualId!]);
        observer?.verify();
        anchor.verify();
        for (const secret of service.definition.secrets)
            this.credentials.mount(id, secret.slot);
        await new ServiceRuntimeInspection(this.plan, this.commands).audit();
    }
    finally {
        anchor.close();
    } } finally {observer?.close();} }
}

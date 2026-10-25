import { createHash } from 'node:crypto';
import { fstatSync } from 'node:fs';
import { posix } from 'node:path';
import { CanonicalJson, PlanningBlockedError, ServiceSchemas, type ServicePlan, type ServiceInstance, type ServiceResourceReceipt } from '@treeseed-cordis/sdk';
import { AuthorityArchive } from './service-export.js';
import { LocalDockerCommands, type ServiceAuthorityCommands } from './service-images.js';
import { ServiceRuntimeInspection } from './service-engine.js';
import { ServicePlanStore } from './service-plan.js';
import { InstallationStore, InstallationWriter } from './installed.js';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';
interface AuthoritySelection { service: ServiceInstance; declaration: ServiceInstance['resources']['authorities'][number]; }
interface AuthoritySource { selection: AuthoritySelection; volume: ServiceResourceReceipt; container: ServiceResourceReceipt; mountTarget: string; path: string; definitionDigest: string; resourceId: string; }
interface Deadline { deadline: number; signal: AbortSignal; }
/** Host-private custody. Native probes receive only bounded reference callbacks. */
export class ServiceAuthorityExports {
    private readonly plan: ServicePlan;
    private readonly store: ServicePlanStore;
    constructor(plan: ServicePlan, private readonly writer?: InstallationWriter, private readonly commands: ServiceAuthorityCommands = new LocalDockerCommands()) { this.plan = ServiceSchemas.plan.parse(plan); this.store = new ServicePlanStore(this.plan.configuration.installationDirectory); }
    private static named(id: string, value: { serviceId: string }): boolean { return id === value.serviceId; }
    private static authority(id: string, value: { id: string }): boolean { return id === value.id; }
    private service(id: string): ServiceInstance { const service = this.plan.composition.services.find(ServiceAuthorityExports.named.bind(null, id)); Check.require(service, 'SERVICE_SCOPE'); return service; }
    private selection(serviceId: string, reference: string): AuthoritySelection {
        Check.require(ServiceSchemas.secretReference.safeParse(reference).success, 'UNGRANTED_PROBE_REFERENCE');
        const consumer = this.service(serviceId), [sourceId, name] = reference.slice('secret://'.length).split('/'), service = this.service(sourceId!), declaration = service.resources.authorities.find(ServiceAuthorityExports.authority.bind(null, name!));
        Check.require(consumer.readiness.credentialReferences.includes(reference) && declaration, 'UNGRANTED_PROBE_REFERENCE');
        if (sourceId !== serviceId) {
            let granted = false, dependency = false;
            for (const grant of consumer.resources.grants) if (grant.serviceId === sourceId && grant.slot === name) granted = true;
            for (const item of consumer.dependencies) for (const binding of service.bindings) if (item.bindingId === binding.bindingId && item.contractId === binding.contractId && item.contractVersion === binding.contractVersion) dependency = true;
            Check.require(granted && dependency, 'UNGRANTED_PROBE_REFERENCE');
        }
        return { service, declaration };
    }
    references(serviceId: string): { authorityIds: readonly string[]; credentialReferences: readonly string[] } {
        const authorityIds: string[] = [], credentialReferences: string[] = [];
        for (const reference of this.service(serviceId).readiness.credentialReferences) {
            const [sourceId, name] = reference.slice('secret://'.length).split('/'), source = this.service(sourceId!);
            if (source.resources.authorities.some(ServiceAuthorityExports.authority.bind(null, name!))) { this.selection(serviceId, reference); authorityIds.push(reference); } else credentialReferences.push(reference);
        }
        return { authorityIds: Object.freeze(authorityIds.sort()), credentialReferences: Object.freeze(credentialReferences.sort()) };
    }
    private deadline(options: Deadline): void { Check.require(Number.isFinite(options.deadline) && !options.signal.aborted && Date.now() < options.deadline, 'PROBE_DEADLINE'); }
    private phase(publishing = false): void {
        Check.require(CanonicalJson.stringify(this.store.read(this.plan.id, this.plan.digest)) === CanonicalJson.stringify(this.plan), 'PLAN_BINDING');
        let accepted = false;
        for (const event of this.store.records()) if (event.planId === this.plan.id && event.digest === this.plan.digest && (publishing ? ['activate', 'readiness'] : ['activate', 'readiness', 'commit', 'completed']).includes(event.phase)) accepted = true;
        Check.require(accepted, 'ACCEPTED_ACTIVATION_REQUIRED');
        if (publishing) { Check.require(this.writer, 'AUTHORITY_NOT_PREPARED'); this.writer.assert(this.store.path); }
    }
    private resources(): ServiceResourceReceipt[] { const latest = new Map<string, ServiceResourceReceipt>(); for (const receipt of this.store.resources()) { const prior = latest.get(receipt.resourceId); if (!prior || prior.references.length < receipt.references.length) latest.set(receipt.resourceId, receipt); } return [...latest.values()]; }
    private source(selection: AuthoritySelection): AuthoritySource {
        const { service, declaration } = selection, name = this.plan.projectName + '_r-' + CanonicalJson.digest({ serviceId: service.serviceId, slot: declaration.volume }).slice(0, 48);
        let volume: ServiceResourceReceipt | undefined, container: ServiceResourceReceipt | undefined;
        for (const resource of this.resources()) {
            if (resource.serviceId === service.serviceId && resource.kind === 'volume' && resource.name === name) { Check.require(!volume, 'AMBIGUOUS_RESOURCE'); volume = resource; }
            if (resource.serviceId === service.serviceId && resource.kind === 'container') { Check.require(!container, 'AMBIGUOUS_RESOURCE'); container = resource; }
        }
        Check.require(volume?.actualId && container?.actualId, 'AUTHORITY_SOURCE_NOT_PREPARED');
        let mount: ServiceInstance['definition']['volumes'][number] | undefined;
        for (const item of service.definition.volumes) if (item.source === declaration.volume) { Check.require(!mount, 'AMBIGUOUS_RESOURCE'); mount = item; }
        Check.require(mount, 'AUTHORITY_SOURCE_NOT_PREPARED');
        const path = posix.join(mount.target, declaration.path), definitionDigest = CanonicalJson.digest({ serviceId: service.serviceId, authority: declaration, volumeResourceId: volume.resourceId, volumeIdentity: volume.actualId, mount: mount.target }), resourceId = CanonicalJson.digest({ installationId: this.plan.configuration.installationId, installationDirectory: this.store.path, kind: 'authority', serviceId: service.serviceId, name: declaration.id, definitionDigest });
        Check.require(ServiceSchemas.containerPath.safeParse(path).success && path.startsWith(mount.target.replace(/\/$/, '') + '/'), 'AUTHORITY_SCOPE');
        return { selection, volume, container, mountTarget: mount.target, path, definitionDigest, resourceId };
    }
    private async inspect(source: AuthoritySource): Promise<void> {
        await new ServiceRuntimeInspection(this.plan, this.commands).audit();
        const values = StrictJson.parse(Buffer.from(await this.commands.run(this.plan.expectedEngine, ['container', 'inspect', source.container.actualId!])));
        Check.require(Array.isArray(values) && values.length === 1, 'AUTHORITY_SOURCE_NOT_PREPARED');
        const container = StrictJson.object(values[0]); Check.require(container.Id === source.container.actualId && Array.isArray(container.Mounts), 'AUTHORITY_SOURCE_NOT_PREPARED');
        let matches = 0;
        for (const value of container.Mounts) { const mount = StrictJson.object(value); if (mount.Destination === source.mountTarget) { Check.require(mount.Type === 'volume' && mount.Name === source.volume.name, 'AUTHORITY_SOURCE_NOT_PREPARED'); matches++; } }
        Check.require(matches === 1, 'AUTHORITY_SOURCE_NOT_PREPARED');
    }
    private directory(create = false): SafeDirectory | null {
        let artifacts: SafeDirectory;
        try { artifacts = this.store.directory('artifacts', create ? this.writer : undefined); } catch (error) { if (!create && error instanceof PlanningBlockedError && error.blockers[0]?.code === 'MISSING_JOURNAL') return null; throw error; }
        try {
            SafeDirectory.owner(fstatSync(artifacts.fd), true);
            if (artifacts.entries().includes('authorities')) return artifacts.directory('authorities', true);
            if (!create) return null;
            this.phase(true); return InstallationStore.mkdir(artifacts, 'authorities');
        } finally { artifacts.close(); }
    }
    private audit(directory: SafeDirectory | null): ServiceResourceReceipt[] {
        const receipts: ServiceResourceReceipt[] = []; for (const item of this.resources()) if (item.kind === 'authority') receipts.push(item);
        if (!directory) { Check.require(receipts.length === 0, 'AUTHORITY_REPAIR_REQUIRED'); return receipts; }
        SafeDirectory.owner(fstatSync(directory.fd), true); directory.verify();
        const paths = new Map<string, ServiceResourceReceipt>();
        for (const receipt of receipts) {
            Check.require(receipt.serviceId && receipt.ownerUid === process.getuid?.() && receipt.actualId && receipt.contentDigest && receipt.path === 'artifacts/authorities/' + receipt.resourceId + '.pem', 'AUTHORITY_SCOPE');
            Check.require(!paths.has(receipt.resourceId + '.pem'), 'AUTHORITY_SCOPE'); paths.set(receipt.resourceId + '.pem', receipt);
        }
        Check.require(directory.entries().length === paths.size && paths.size > 0, 'AUTHORITY_REPAIR_REQUIRED');
        for (const name of directory.entries()) { const receipt = paths.get(name); Check.require(receipt, 'AUTHORITY_REPAIR_REQUIRED'); AuthorityArchive.certificate(directory.file(name, receipt.contentDigest!, 128 * 1024, true)); }
        SafeDirectory.owner(fstatSync(directory.fd), true); directory.verify(); return receipts;
    }
    private cached(source: AuthoritySource,retained=false): Buffer | null {
        const directory = this.directory(); try {
            let found: ServiceResourceReceipt | undefined;
            for (const receipt of this.audit(directory)) if (receipt.resourceId === source.resourceId) { Check.require(!found && receipt.definitionDigest === source.definitionDigest && receipt.actualId === source.volume.actualId && receipt.serviceId === source.selection.service.serviceId && receipt.name === source.selection.declaration.id, 'AUTHORITY_SCOPE'); found = receipt; }
            if (!found) return null;
            Check.require(found.references.includes(this.plan.compositionGeneration)||(retained&&this.writer),'AUTHORITY_GENERATION');
            return AuthorityArchive.certificate(directory!.file(source.resourceId + '.pem', found.contentDigest!, 128 * 1024, true));
        } finally { directory?.close(); }
    }
    async read(serviceId: string, reference: string, options: Deadline): Promise<Buffer> {
        this.deadline(options); const selection = this.selection(serviceId, reference); this.phase(); const source = this.source(selection), cached = this.cached(source,Boolean(this.writer));
        if(cached){let receipt:ServiceResourceReceipt|undefined;for(const candidate of this.resources())if(candidate.resourceId===source.resourceId)receipt=candidate;Check.require(receipt,'AUTHORITY_SCOPE');if(!receipt.references.includes(this.plan.compositionGeneration)){this.phase(true);this.deadline(options);await this.inspect(source);this.deadline(options);this.writer!.assert(this.store.path);const current=this.source(selection);Check.require(current.resourceId===source.resourceId&&current.container.actualId===source.container.actualId,'RESOURCE_IDENTITY_CHANGED');this.store.saveResource({...receipt,references:[...receipt.references,this.plan.compositionGeneration].sort()},this.writer!);await this.inspect(current);this.deadline(options);const after=this.cached(current);Check.require(after&&after.equals(cached),'AUTHORITY_CONTENT_CHANGED');return after;}this.deadline(options);return cached;}
        this.phase(true); this.deadline(options);
        await this.inspect(source); this.deadline(options);
        const target = await new ServiceRuntimeInspection(this.plan, this.commands).service(selection.service.serviceId); this.deadline(options); Check.require(target.running && target.actualId === source.container.actualId, 'AUTHORITY_SOURCE_NOT_PREPARED');
        const bytes = await AuthorityArchive.read(await this.commands.archive(this.plan.expectedEngine, source.container.actualId!, source.path, Math.max(1, Math.min(10000, options.deadline - Date.now()))), posix.basename(source.path));
        this.deadline(options); await this.inspect(source); this.deadline(options); this.phase(true);
        const current = this.source(selection); Check.require(current.resourceId === source.resourceId && current.container.actualId === source.container.actualId, 'RESOURCE_IDENTITY_CHANGED');
        const repeated = this.cached(current); if (repeated) { Check.require(repeated.equals(bytes), 'AUTHORITY_CONTENT_CHANGED'); return repeated; }
        this.deadline(options); const directory = this.directory(true)!;
        try {
            this.deadline(options); this.phase(true); SafeDirectory.owner(fstatSync(directory.fd), true); directory.verify();
            InstallationStore.publish(directory, source.resourceId + '.pem', bytes); this.deadline(options);
            this.store.saveResource(ServiceSchemas.resourceReceipt.parse({ formatVersion: 3, installationId: this.plan.configuration.installationId, installationDirectory: this.store.path, resourceId: source.resourceId, kind: 'authority', serviceId: selection.service.serviceId, name: selection.declaration.id, creatingGeneration: this.plan.compositionGeneration, definitionDigest: source.definitionDigest, references: [this.plan.compositionGeneration], actualId: source.volume.actualId, contentDigest: createHash('sha256').update(bytes).digest('hex'), imageDigest: null, path: 'artifacts/authorities/' + source.resourceId + '.pem', ownerUid: process.getuid!(), legacy: null }), this.writer!);
            this.audit(directory); return Buffer.from(bytes);
        } finally { directory.close(); }
    }
}

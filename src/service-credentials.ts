import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { CanonicalJson, ServiceSchemas, PlanningBlockedError, type ServicePlan, type ServiceInstance, type ServiceResourceReceipt } from '@treeseed-cordis/sdk';
import { ServicePlanStore } from './service-plan.js';
import { InstallationStore, InstallationWriter } from './installed.js';
import { SafeDirectory, PlanningFailure as Check } from './filesystem.js';
interface Slot {
    reference: string;
    service: ServiceInstance;
    name: string;
    definition: ServiceInstance['resources']['slots'][string];
    references: Set<string>;
}
interface PreparedSlot {
    slot: Slot;
    bytes: Buffer;
    receipt: ServiceResourceReceipt;
}
/** Coherent private custody: no replaceable permission policy or independent writer. */
export class ServiceCredentials {
    private readonly plan: ServicePlan;
    private readonly store: ServicePlanStore;
    private readonly slots = new Map<string, Slot>();
    private nodes = 0;
    constructor(plan: ServicePlan) { this.plan = ServiceSchemas.plan.parse(plan); this.store = new ServicePlanStore(this.plan.configuration.installationDirectory); for (const service of this.plan.composition.services)
        for (const [name, definition] of Object.entries(service.resources.slots)) {
            const reference = 'secret://' + service.serviceId + '/' + name;
            this.slots.set(reference, { reference, service, name, definition, references: new Set() });
        } for (const slot of this.slots.values())
        if (slot.definition.value !== undefined)
            this.references(slot.definition.value, slot, 0); for (const slot of this.slots.values())
        ServiceCredentials.visit(slot.reference, this.slots, new Set(), new Set()); }
    private static visit(reference: string, slots: Map<string, Slot>, visiting: Set<string>, visited: Set<string>): void { Check.require(!visiting.has(reference), 'SECRET_REFERENCE_CYCLE'); if (visited.has(reference))
        return; visiting.add(reference); for (const dependency of slots.get(reference)!.references)
        this.visit(dependency, slots, visiting, visited); visiting.delete(reference); visited.add(reference); }
    private references(value: unknown, slot: Slot, depth: number): void { Check.require(depth <= 32 && ++this.nodes <= 100000, 'PRIVATE_CONFIG_LIMIT'); if (Array.isArray(value)) {
        for (const item of value)
            this.references(item, slot, depth + 1);
        return;
    } if (value && typeof value === 'object') {
        const object = value as Record<string, unknown>;
        if (Object.keys(object).length === 1 && Object.hasOwn(object, '$secret')) {
            const reference = ServiceSchemas.secretReference.safeParse(object.$secret);
            Check.require(reference.success && this.slots.has(reference.data), 'INVALID_SECRET_REFERENCE');
            this.grant(slot.service.serviceId, reference.data);
            slot.references.add(reference.data);
            return;
        }
        for (const [key, item] of Object.entries(object)) {
            Check.require(!['__proto__', 'constructor', 'prototype'].includes(key) && (!key.startsWith('$') || key === '$template'), 'INVALID_PRIVATE_CONFIG');
            this.references(item, slot, depth + 1);
        }
    } }
    private grant(serviceId: string, reference: string): Slot { const source = this.slots.get(reference), service = this.plan.composition.services.find(ServiceCredentials.named.bind(null, serviceId)); Check.require(source && service, 'SERVICE_SCOPE'); if (source.service.serviceId !== serviceId) {
        let granted = false;
        for (const grant of service.resources.grants)
            if (grant.serviceId === source.service.serviceId && grant.slot === source.name)
                granted = true;
        Check.require(granted, 'UNGRANTED_SECRET_REFERENCE');
    } return source; }
    private static named(id: string, service: ServiceInstance): boolean { return service.serviceId === id; }
    private existing(): ServiceResourceReceipt[] { const resources: ServiceResourceReceipt[] = []; for (const receipt of this.store.resources())
        if (receipt.kind === 'secret' || receipt.kind === 'configuration')
            resources.push(receipt); return resources; }
    private directory(): SafeDirectory | null { try {
        return this.store.directory('credentials');
    }
    catch (error) {
        if (error instanceof PlanningBlockedError && error.blockers[0]?.code === 'MISSING_JOURNAL')
            return null;
        throw error;
    } }
    private audit(directory: SafeDirectory | null, resources: ServiceResourceReceipt[]): void { if (!directory) {
        Check.require(resources.length === 0, 'MISSING_CREDENTIALS');
        return;
    } const paths = new Map<string, string>(); for (const receipt of resources) {
        Check.require(receipt.path && receipt.contentDigest && receipt.serviceId && receipt.ownerUid === process.getuid?.() && receipt.path === 'credentials/' + receipt.serviceId + '/' + receipt.name + '-' + receipt.definitionDigest, 'CREDENTIAL_SCOPE');
        const prior = paths.get(receipt.path);
        Check.require(!prior || prior === receipt.contentDigest, 'CREDENTIAL_SCOPE');
        paths.set(receipt.path, receipt.contentDigest);
    } Check.require(directory.entries().length > 0 || paths.size > 0, 'INCOMPLETE_CREDENTIALS'); for (const serviceId of directory.entries()) {
        Check.require(ServiceSchemas.serviceId.safeParse(serviceId).success, 'CREDENTIAL_SCOPE');
        const service = directory.directory(serviceId, true);
        try {
            Check.require(service.entries().length > 0, 'INCOMPLETE_CREDENTIALS');
            for (const file of service.entries()) {
                const path = 'credentials/' + serviceId + '/' + file, hash = paths.get(path);
                Check.require(hash, 'INCOMPLETE_CREDENTIALS');
                service.file(file, hash, 4 * 1024 * 1024, true);
            }
        }
        finally {
            service.close();
        }
    } for (const [path, hash] of paths)
        directory.file(path.slice('credentials/'.length), hash, 4 * 1024 * 1024, true); directory.verify(); }
    private account(value: unknown, budget: {
        bytes: number;
        nodes: number;
    }): void { budget.bytes += Buffer.byteLength(JSON.stringify(value) ?? 'null'); Check.require(budget.bytes <= 4 * 1024 * 1024 && ++budget.nodes <= 100000, 'PRIVATE_CONFIG_LIMIT'); }
    private resolve(value: unknown, values: Map<string, PreparedSlot>, depth = 0, budget = { bytes: 0, nodes: 0 }): unknown { Check.require(depth <= 32, 'PRIVATE_CONFIG_LIMIT'); if (Array.isArray(value)) {
        const output: unknown[] = [];
        for (const item of value)
            output.push(this.resolve(item, values, depth + 1, budget));
        return output;
    } if (value && typeof value === 'object') {
        const object = value as Record<string, unknown>, keys = Object.keys(object);
        if (keys.length === 1 && Object.hasOwn(object, '$secret')) {
            const selected = values.get(String(object.$secret));
            Check.require(selected, 'INVALID_SECRET_REFERENCE');
            const text = new TextDecoder('utf-8', { fatal: true }).decode(selected.bytes);
            this.account(text, budget);
            return text;
        }
        if (keys.length === 1 && Object.hasOwn(object, '$template')) {
            Check.require(Array.isArray(object.$template) && object.$template.length <= 256, 'INVALID_PRIVATE_CONFIG');
            let output = '';
            for (const item of object.$template) {
                const resolved = this.resolve(item, values, depth + 1, budget);
                Check.require(typeof resolved === 'string' || typeof resolved === 'number' || typeof resolved === 'boolean', 'INVALID_PRIVATE_CONFIG');
                output += String(resolved);
                Check.require(Buffer.byteLength(output) <= 4 * 1024 * 1024, 'PRIVATE_CONFIG_LIMIT');
            }
            return output;
        }
        const output: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(object)) {
            this.account(key, budget);
            output[key] = this.resolve(item, values, depth + 1, budget);
        }
        return output;
    } this.account(value, budget); return value; }
    private bytes(slot: Slot, values: Map<string, PreparedSlot>): Buffer { const definition = slot.definition; if (definition.kind === 'random')
        return Buffer.from(randomBytes(32).toString('hex')); if (definition.kind === 'uuid')
        return Buffer.from(randomUUID()); const value = this.resolve(definition.value, values); let text: string; if (definition.kind === 'json')
        text = CanonicalJson.stringify(value) + '\n';
    else if (definition.kind === 'properties') {
        Check.require(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_PRIVATE_CONFIG');
        const lines: string[] = [];
        for (const key of Object.keys(value).sort()) {
            const entry = Reflect.get(value, key);
            Check.require(/^[a-z][a-z0-9.-]*$/.test(key) && (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') && !/[\r\n\0]/.test(String(entry)), 'INVALID_PRIVATE_CONFIG');
            lines.push(key + '=' + String(entry));
        }
        text = lines.join('\n') + '\n';
    }
    else {
        Check.require(typeof value === 'string', 'INVALID_PRIVATE_CONFIG');
        text = value;
    } const bytes = Buffer.from(text); Check.require(bytes.length <= 4 * 1024 * 1024, 'PRIVATE_CONFIG_LIMIT'); return bytes; }
    private candidates(directory: SafeDirectory | null, resources: ServiceResourceReceipt[], generate: boolean): Map<string, PreparedSlot> { const result = new Map<string, PreparedSlot>(), waiting = new Set(this.slots.keys()); let totalBytes = 0; while (waiting.size) {
        let progress = false;
        for (const reference of [...waiting]) {
            const slot = this.slots.get(reference)!;
            let ready = true;
            for (const dependency of slot.references)
                if (!result.has(dependency))
                    ready = false;
            if (!ready)
                continue;
            const dependencies = [];
            for (const dependency of [...slot.references].sort())
                dependencies.push({ reference: dependency, contentDigest: result.get(dependency)!.receipt.contentDigest });
            const definitionDigest = CanonicalJson.digest({ definition: slot.definition, dependencies }), kind = slot.definition.kind === 'random' || slot.definition.kind === 'uuid' ? 'secret' as const : 'configuration' as const, resourceId = CanonicalJson.digest({ installationId: this.plan.configuration.installationId, installationDirectory: this.store.path, serviceId: slot.service.serviceId, slot: slot.name, kind, definitionDigest });
            let previous: ServiceResourceReceipt | undefined;
            for (const receipt of resources)
                if (receipt.resourceId === resourceId && (!previous || receipt.references.length > previous.references.length))
                    previous = receipt;
            let bytes: Buffer, receipt: ServiceResourceReceipt;
            if (previous) {
                Check.require(directory && previous.path && previous.contentDigest && previous.definitionDigest === definitionDigest && previous.name === slot.name && previous.serviceId === slot.service.serviceId, 'CREDENTIAL_SCOPE');
                bytes = directory.file(previous.path.slice('credentials/'.length), previous.contentDigest, 4 * 1024 * 1024, true);
                receipt = previous;
            }
            else {
                Check.require(generate, 'MISSING_CREDENTIALS');
                bytes = this.bytes(slot, result);
                receipt = ServiceSchemas.resourceReceipt.parse({ formatVersion: 3, installationId: this.plan.configuration.installationId, installationDirectory: this.store.path, resourceId, kind, serviceId: slot.service.serviceId, name: slot.name, creatingGeneration: this.plan.compositionGeneration, definitionDigest, references: [this.plan.compositionGeneration], actualId: null, contentDigest: createHash('sha256').update(bytes).digest('hex'), imageDigest: null, path: 'credentials/' + slot.service.serviceId + '/' + slot.name + '-' + definitionDigest, ownerUid: process.getuid!(), legacy: null });
            }
            totalBytes += bytes.length;
            Check.require(totalBytes <= 64 * 1024 * 1024, 'PRIVATE_CONFIG_LIMIT');
            result.set(reference, { slot, bytes, receipt });
            waiting.delete(reference);
            progress = true;
        }
        Check.require(progress, 'SECRET_REFERENCE_CYCLE');
    } return result; }
    async prepare(writer: InstallationWriter): Promise<void> { writer.assert(this.store.path); Check.require(CanonicalJson.stringify(this.store.read(this.plan.id, this.plan.digest)) === CanonicalJson.stringify(this.plan), 'PLAN_BINDING'); let accepted = false; for (const record of this.store.records())
        if (record.planId === this.plan.id && record.phase === 'prepare')
            accepted = true; Check.require(accepted, 'ACCEPTED_PREPARATION_REQUIRED'); if (this.slots.size === 0)
        return; const resources = this.existing(); let directory = this.directory(); try {
        this.audit(directory, resources);
        const values = this.candidates(directory, resources, true);
        if (!directory)
            directory = this.store.directory('credentials', writer);
        for (const item of values.values()) {
            writer.assert(this.store.path);
            const serviceId = item.slot.service.serviceId, service = directory.entries().includes(serviceId) ? directory.directory(serviceId, true) : InstallationStore.mkdir(directory, serviceId);
            try {
                InstallationStore.publish(service, item.slot.name + '-' + item.receipt.definitionDigest, item.bytes);
            }
            finally {
                service.close();
            }
            const references = [...item.receipt.references];
            if (!references.includes(this.plan.compositionGeneration))
                references.push(this.plan.compositionGeneration);
            references.sort();
            this.store.saveResource({ ...item.receipt, references }, writer);
        }
        this.audit(directory, this.existing());
    }
    finally {
        directory?.close();
    } }
    read(serviceId: string, reference: string): Buffer { this.grant(serviceId, reference); const resources = this.existing(), directory = this.directory(); try {
        this.audit(directory, resources);
        const value = this.candidates(directory, resources, false).get(reference);
        Check.require(value, 'MISSING_CREDENTIALS');
        return Buffer.from(value.bytes);
    }
    finally {
        directory?.close();
    } }
    mount(serviceId:string,slot:string):{path:string;resourceId:string;contentDigest:string}{const service=this.plan.composition.services.find(ServiceCredentials.named.bind(null,serviceId));let declared=false;for(const secret of service?.definition.secrets??[])if(secret.slot===slot)declared=true;Check.require(declared,'UNGRANTED_SECRET_MOUNT');const reference='secret://'+serviceId+'/'+slot;this.grant(serviceId,reference);const resources=this.existing(),directory=this.directory();try{this.audit(directory,resources);const value=this.candidates(directory,resources,false).get(reference);Check.require(value?.receipt.path&&value.receipt.contentDigest,'MISSING_CREDENTIALS');return {path:value.receipt.path,resourceId:value.receipt.resourceId,contentDigest:value.receipt.contentDigest};}finally{directory?.close();}}
    probe(serviceId: string, reference: string): Buffer { const service = this.plan.composition.services.find(ServiceCredentials.named.bind(null, serviceId)); Check.require(service && service.readiness.credentialReferences.includes(reference), 'UNGRANTED_PROBE_REFERENCE'); return this.read(serviceId, reference); }
}

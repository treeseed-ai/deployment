import { CanonicalJson, ServiceSchemas, ServiceWorkerSchemas, type ServicePlan, type ServiceApplicationRecord, type ServiceWorkerRequest, type ServiceSnapshot as CompositionSnapshot, type ServiceResourceReceipt as ResourceReceipt } from '@treeseed-cordis/sdk';
import { InstallationStore, InstallationWriter } from './installed.js';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';
export interface ServiceJournalData {
    events: ServiceApplicationRecord[];
    records: ServiceApplicationRecord[];
    resources: ResourceReceipt[];
    snapshots: Map<string, CompositionSnapshot>;
    current: CompositionSnapshot | null;
}
/** Validation/publication helper for ServicePlanStore's existing state and writer. */
export class ServiceJournal {
    constructor(private readonly state: SafeDirectory, private readonly plans: Map<string, ServicePlan>) { }
    private static schema<T>(schema: {
        safeParse(value: unknown): {
            success: boolean;
            data?: T;
        };
    }, value: unknown): T { const result = schema.safeParse(value); Check.require(result.success, 'INVALID_JOURNAL'); return result.data!; }
    private reference(): ServicePlan { const plan = this.plans.values().next().value; Check.require(plan, 'INCOMPLETE_JOURNAL'); return plan; }
    private files(name: string, maximum: number): Array<{
        name: string;
        value: unknown;
    }> { if (!this.state.entries().includes(name))
        return []; const directory = this.state.directory(name, true); try {
        const names = directory.entries();
        Check.require(names.length <= 100000, 'JOURNAL_LIMIT');
        const result = [];
        for (const file of names)
            result.push({ name: file, value: StrictJson.parse(directory.file(file, undefined, maximum, true)) });
        return result;
    }
    finally {
        directory.close();
    } }
    private scope(value: {
        installationId: string;
        installationDirectory: string;
    }): void { const plan = this.reference(); Check.require(value.installationId === plan.configuration.installationId && value.installationDirectory === plan.configuration.installationDirectory, 'FOREIGN_INSTALLATION'); }
    static resourceName(value: ResourceReceipt): string { return value.resourceId + '.' + CanonicalJson.digest(value) + '.json'; }
    static snapshotName(value: CompositionSnapshot): string { return value.compositionGeneration + '.' + CanonicalJson.digest(value) + '.json'; }
    private static eventName(record: ServiceApplicationRecord, order: number): string { return String(order).padStart(12, '0') + '.' + record.id + '.' + String(record.sequence).padStart(8, '0') + '.' + CanonicalJson.digest(record) + '.json'; }
    static requestDigest(plan: ServicePlan, request: Extract<ServiceWorkerRequest, {
        operation: 'submit';
    }>): string { return CanonicalJson.digest({ request:request.restartServices?{...request,restartServices:[...request.restartServices].sort()}:request, installationId: plan.configuration.installationId, installationDirectory: plan.configuration.installationDirectory, expectedEngine: plan.expectedEngine }); }
    read(extra?: {
        resource?: ResourceReceipt;
        snapshot?: CompositionSnapshot;
        event?: ServiceApplicationRecord;
    }): ServiceJournalData {
        const resources: ResourceReceipt[] = [], byDigest = new Map<string, ResourceReceipt>(), versions = new Map<string, ResourceReceipt[]>(), generations = new Set<string>();
        for (const plan of this.plans.values())
            generations.add(plan.compositionGeneration);
        for (const file of this.files('resources', 1024 * 1024)) {
            const receipt = ServiceJournal.schema(ServiceSchemas.resourceReceipt, file.value);
            Check.require(file.name === ServiceJournal.resourceName(receipt), 'INVALID_RESOURCE_RECEIPT');
            resources.push(receipt);
        }
        if (extra?.resource)
            resources.push(ServiceJournal.schema(ServiceSchemas.resourceReceipt, extra.resource));
        for (const receipt of resources) {
            this.scope(receipt);
            Check.require(receipt.ownerUid === process.getuid?.() && generations.has(receipt.creatingGeneration) && receipt.references.every(generations.has.bind(generations)), 'RESOURCE_SCOPE');
            if (receipt.serviceId !== null) {
                let owned = false;
                for (const plan of this.plans.values())
                    if (plan.compositionGeneration === receipt.creatingGeneration)
                        for (const service of plan.composition.services)
                            if (service.serviceId === receipt.serviceId)
                                owned = true;
                Check.require(owned, 'RESOURCE_SERVICE_SCOPE');
            }
            Check.require((receipt.kind === 'container' && receipt.serviceId !== null) || receipt.kind !== 'container', 'RESOURCE_SERVICE_SCOPE');
            const digest = CanonicalJson.digest(receipt);
            byDigest.set(digest, receipt);
            const group = versions.get(receipt.resourceId) ?? [];
            for (const previous of group) {
                const { references: before, ...prior } = previous, { references: after, ...next } = receipt;
                Check.require(CanonicalJson.stringify(prior) === CanonicalJson.stringify(next), 'RESOURCE_IDENTITY_CHANGED');
                Check.require(ServiceJournal.subset(before, after) || ServiceJournal.subset(after, before), 'RESOURCE_REFERENCE_FORK');
            }
            group.push(receipt);
            versions.set(receipt.resourceId, group);
        }
        const snapshots = new Map<string, CompositionSnapshot>();
        const snapshotValues: CompositionSnapshot[] = [];
        for (const file of this.files('snapshots', 4 * 1024 * 1024)) {
            const value = ServiceJournal.schema(ServiceSchemas.snapshot, file.value);
            Check.require(file.name === ServiceJournal.snapshotName(value), 'INVALID_SNAPSHOT');
            snapshotValues.push(value);
        }
        if (extra?.snapshot)
            snapshotValues.push(ServiceJournal.schema(ServiceSchemas.snapshot, extra.snapshot));
        for (const snapshot of snapshotValues) {
            this.scope(snapshot);
            Check.require(generations.has(snapshot.compositionGeneration) && snapshot.acknowledgements.length > 0, 'SNAPSHOT_SCOPE');
            for (const ack of snapshot.acknowledgements)
                Check.require(ack.ready, 'UNREADY_SNAPSHOT');
            const ids = new Set<string>();
            for (const binding of snapshot.resources) {
                const receipt = byDigest.get(binding.receiptDigest);
                Check.require(receipt && receipt.resourceId === binding.resourceId && receipt.kind === binding.kind && receipt.serviceId === binding.serviceId && receipt.creatingGeneration === binding.creatingGeneration && receipt.references.includes(snapshot.compositionGeneration) && !ids.has(binding.resourceId), 'RESOURCE_BINDING');
                ids.add(binding.resourceId);
            }
            const previous = snapshots.get(snapshot.compositionGeneration);
            Check.require(!previous || CanonicalJson.stringify(previous) === CanonicalJson.stringify(snapshot), 'SNAPSHOT_CONFLICT');
            snapshots.set(snapshot.compositionGeneration, snapshot);
        }
        const events: ServiceApplicationRecord[] = [];
        for (const file of this.files('applications', 1024 * 1024)) {
            const record = ServiceJournal.schema(ServiceSchemas.applicationRecord, file.value);
            Check.require(file.name === ServiceJournal.eventName(record, events.length), 'INVALID_APPLICATION_ORDER');
            events.push(record);
        }
        if (extra?.event)
            events.push(ServiceJournal.schema(ServiceSchemas.applicationRecord, extra.event));
        const latest = new Map<string, ServiceApplicationRecord>(), keys = new Map<string, string>();
        let current: CompositionSnapshot | null = null;
        let pending: string | null = null;
        let fenced = false;
        for (const record of events) {
            const plan = this.plans.get(record.planId);
            Check.require(plan && record.digest === plan.digest && record.desiredComposition === plan.compositionGeneration && record.expectedComposition === plan.expectedComposition, 'APPLICATION_SCOPE');
            const request = ServiceWorkerSchemas.submit.parse({ protocol: 3, operation: 'submit', planId: record.planId, digest: record.digest, idempotencyKey: record.idempotencyKey,...(record.restartServices?{restartServices:record.restartServices}:{}) }), intent = ServiceJournal.requestDigest(plan, request);
            Check.require(record.id === 'app-' + intent && record.requestDigest === intent && record.historyReference === '.cordis/applications/' + record.id, 'APPLICATION_INTENT');
            const previous = latest.get(record.id);
            Check.require(record.sequence === (previous ? previous.sequence + 1 : 0) && record.sequence < 100000000, 'APPLICATION_SEQUENCE');
            if (previous) {
                Check.require(pending === record.id && !ServiceJournal.terminal(previous) && previous.requestDigest === record.requestDigest && previous.expectedComposition === record.expectedComposition, 'APPLICATION_BUSY');
                Check.require(record.phase === 'failed' || record.phase === 'cancelled' || ServiceJournal.phase(record.phase) >= ServiceJournal.phase(previous.phase), 'APPLICATION_PHASE');
            }
            else {
                Check.require(!pending && !fenced && record.phase === 'validate' && record.result === 'accepted' && !keys.has(record.idempotencyKey), 'APPLICATION_BUSY');
                Check.require((current?.compositionGeneration ?? null) === plan.expectedComposition && (current ? CanonicalJson.digest(current.resources) : null) === plan.expectedResourceSet, 'STALE_GENERATION');
                keys.set(record.idempotencyKey, record.requestDigest);
                pending = record.id;
            }
            if (record.phase === 'completed') {
                Check.require(record.recovery === null, 'APPLICATION_RECOVERY');
                Check.require(previous?.phase === 'commit', 'APPLICATION_PHASE');
                if (record.result === 'ready') {
                    const snapshot = snapshots.get(plan.compositionGeneration);
                    Check.require(snapshot && record.activeComposition === plan.compositionGeneration && record.resourceSetDigest === CanonicalJson.digest(snapshot.resources) && CanonicalJson.stringify(record.acknowledgements) === CanonicalJson.stringify(snapshot.acknowledgements), 'UNVERIFIED_COMPLETION');
                    current = snapshot;
                }
                else
                    Check.require(record.result === 'stopped' && current === null && record.activeComposition === null, 'UNVERIFIED_COMPLETION');
                pending = null;
            }
            else {
                Check.require(record.resourceSetDigest === plan.expectedResourceSet, 'APPLICATION_RESOURCE_SET');
                Check.require(record.activeComposition === (current?.compositionGeneration ?? null), 'UNVERIFIED_COMPLETION');
                if (record.phase === 'failed' || record.phase === 'cancelled') {
                    Check.require((record.phase === 'failed' && ['failed', 'blocked'].includes(record.result ?? '')) || (record.phase === 'cancelled' && record.result === null), 'APPLICATION_RESULT');
                    pending = null;
                    if (record.recovery)
                        fenced = true;
                }
                else
                    Check.require(record.recovery === null, 'APPLICATION_RECOVERY');
            }
            latest.set(record.id, record);
        }
        const acceptedGenerations = new Set<string>();
        for (const event of events)
            acceptedGenerations.add(event.desiredComposition);
        for (const resource of resources)
            Check.require(acceptedGenerations.has(resource.creatingGeneration), 'RESOURCE_BEFORE_ACCEPTANCE');
        for (const snapshot of snapshots.values())
            Check.require(acceptedGenerations.has(snapshot.compositionGeneration), 'SNAPSHOT_BEFORE_ACCEPTANCE');
        return { events, records: [...latest.values()], resources, snapshots, current };
    }
    private static subset(left: string[], right: string[]): boolean { for (const value of left)
        if (!right.includes(value))
            return false; return true; }
    private static terminal(record: ServiceApplicationRecord): boolean { return ['completed', 'failed', 'cancelled'].includes(record.phase); }
    private static phase(value: string): number { return ['resolve', 'validate', 'stage', 'prepare', 'drain', 'activate', 'readiness', 'commit', 'completed'].indexOf(value); }
    private publish(name: string, file: string, value: unknown, writer: InstallationWriter): void { writer.assert(this.reference().configuration.installationDirectory); let directory: SafeDirectory; if (this.state.entries().includes(name))
        directory = this.state.directory(name, true);
    else
        directory = InstallationStore.mkdir(this.state, name); try {
        InstallationStore.publish(directory, file, value);
    }
    finally {
        directory.close();
    } }
    accept(request: Extract<ServiceWorkerRequest, {
        operation: 'submit';
    }>, writer: InstallationWriter): {
        record: ServiceApplicationRecord;
        fresh: boolean;
    } { writer.assert(this.reference().configuration.installationDirectory); request = ServiceWorkerSchemas.submit.parse(request); const plan = this.plans.get(request.planId); Check.require(plan && plan.digest === request.digest, 'PLAN_IDENTITY'); const data = this.read(), requestDigest = ServiceJournal.requestDigest(plan, request); for (const record of data.records)
        if (record.idempotencyKey === request.idempotencyKey) {
            Check.require(record.requestDigest === requestDigest, 'IDEMPOTENCY_CONFLICT');
            return { record, fresh: false };
        } const record = ServiceJournal.schema(ServiceSchemas.applicationRecord, {...(request.restartServices?{restartServices:[...request.restartServices].sort()}:{}), formatVersion: 3, id: 'app-' + requestDigest, planId: plan.id, digest: plan.digest, idempotencyKey: request.idempotencyKey, requestDigest, sequence: 0, phase: 'validate', desiredComposition: plan.compositionGeneration, activeComposition: data.current?.compositionGeneration ?? null, result: 'accepted', recovery: null, historyReference: '.cordis/applications/app-' + requestDigest, expectedComposition: plan.expectedComposition, resourceSetDigest: data.current ? CanonicalJson.digest(data.current.resources) : null, acknowledgements: [] }); this.append(record, writer); return { record, fresh: true }; }
    append(record: ServiceApplicationRecord, writer: InstallationWriter): void { writer.assert(this.reference().configuration.installationDirectory); const existing = this.read(); for (const previous of existing.events)
        if (previous.id === record.id && previous.sequence === record.sequence) {
            Check.require(CanonicalJson.stringify(previous) === CanonicalJson.stringify(record), 'APPLICATION_CONFLICT');
            return;
        } const data = this.read({ event: record }); this.publish('applications', ServiceJournal.eventName(record, data.events.length - 1), record, writer); this.read(); }
    saveResource(receipt: ResourceReceipt, writer: InstallationWriter): void { writer.assert(this.reference().configuration.installationDirectory); const before = this.read(); for (const previous of before.resources)
        if (previous.resourceId === receipt.resourceId)
            Check.require(ServiceJournal.subset(previous.references, receipt.references), 'RESOURCE_REFERENCE_REMOVAL'); this.read({ resource: receipt }); this.publish('resources', ServiceJournal.resourceName(receipt), receipt, writer); this.read(); }
    saveSnapshot(snapshot: CompositionSnapshot, writer: InstallationWriter): void { writer.assert(this.reference().configuration.installationDirectory); this.read({ snapshot }); this.publish('snapshots', ServiceJournal.snapshotName(snapshot), snapshot, writer); this.read(); }
}

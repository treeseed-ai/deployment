import { fstatSync, renameSync, fsyncSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CanonicalJson, PlatformSchemas, ServiceSchemas, ServiceWorkerSchemas, PluginManagementSchemas, PluginSource, type ServicePlan, type PluginInstallRequest, type PluginSelectRequest, type PluginRequestRecord } from '@treeseed-cordis/sdk';
import { InstallationStore, type InstallationWriter } from './installed.js';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';
interface PluginScope {
    installationId: string;
    installationDirectory: string;
}
interface RequestEvent {
    formatVersion: 1;
    previousDigest: string | null;
    record: PluginRequestRecord;
}
/** Private custody, not a second provider resolver or authority grant. */
export class PluginRequestJournal {
    static readonly head = z.strictObject({ formatVersion: z.literal(1), count: z.number().int().positive().max(100000), digest: PlatformSchemas.digest });
    private static readonly event = z.strictObject({ formatVersion: z.literal(1), previousDigest: PlatformSchemas.digest.nullable(), record: ServiceWorkerSchemas.requestRecord });
    static read(state: SafeDirectory, scope: PluginScope, extra?: RequestEvent): {
        records: PluginRequestRecord[];
        count: number;
        digest: string | null;
    } {
        const events: RequestEvent[] = [];
        let committed: {
            count: number;
            digest: string;
        } | null = null;
        if (state.entries().includes('plugins')) {
            const plugins = state.directory('plugins', true);
            try {
                Check.require(plugins.entries().join(',') === 'head.json,requests', 'INVALID_PLUGIN_JOURNAL');
                const headBytes = plugins.file('head.json', undefined, 1024, true), head = this.head.safeParse(StrictJson.parse(headBytes));
                Check.require(head.success && headBytes.toString('utf8') === CanonicalJson.stringify(head.data) + '\n', 'PLUGIN_JOURNAL_HEAD');
                committed = head.data;
                const directory = plugins.directory('requests', true);
                try {
                    const names = directory.entries();
                    Check.require(names.length > 0 && names.length <= 100000, 'INCOMPLETE_PLUGIN_JOURNAL');
                    for (const name of names) {
                        const bytes = directory.file(name, undefined, 4 * 1024 * 1024, true), parsed = this.event.safeParse(StrictJson.parse(bytes));
                        Check.require(parsed.success, 'INVALID_PLUGIN_JOURNAL');
                        Check.require(bytes.toString('utf8') === CanonicalJson.stringify(parsed.data) + '\n', 'PLUGIN_RECORD_BYTES');
                        Check.require(name === this.name(parsed.data, events.length), 'INVALID_PLUGIN_JOURNAL');
                        events.push(parsed.data);
                    }
                    directory.verify();
                }
                finally {
                    directory.close();
                }
                plugins.verify();
            }
            finally {
                plugins.close();
            }
        }
        if (committed)
            Check.require(events.length === committed.count && CanonicalJson.digest(events.at(-1)) === committed.digest, 'PLUGIN_JOURNAL_HEAD');
        if (extra)
            events.push(this.event.parse(extra));
        const latest = new Map<string, PluginRequestRecord>();
        let digest: string | null = null;
        for (const event of events) {
            Check.require(event.previousDigest === digest, 'PLUGIN_JOURNAL_CHAIN');
            this.record(event.record, latest.get(event.record.requestId), scope);
            latest.set(event.record.requestId, event.record);
            digest = CanonicalJson.digest(event);
        }
        state.verify();
        return { records: [...latest.values()], count: events.length, digest };
    }
    static name(event: RequestEvent, index: number): string { return String(index).padStart(12, '0') + '.' + CanonicalJson.digest(event) + '.json'; }
    private static record(record: PluginRequestRecord, previous: PluginRequestRecord | undefined, scope: PluginScope): void {
        Check.require(record.installationId === scope.installationId && record.installationDirectory === scope.installationDirectory, 'PLUGIN_REQUEST_SCOPE');
        Check.require(record.intentDigest === CanonicalJson.digest(record.intent), 'PLUGIN_INTENT_DIGEST');
        if (!previous) {
            Check.require(record.sequence === 0 && record.stage === 'received' && record.resolution === null && record.sourceReceipt === null && record.result === null, 'PLUGIN_INITIAL_RECORD');
            return;
        }
        Check.require(record.sequence === previous.sequence + 1, 'PLUGIN_REQUEST_SEQUENCE');
        for (const key of ['requestId', 'installationId', 'installationDirectory', 'operation', 'intent', 'intentDigest', 'expectedGeneration', 'policyDigest'] as const)
            Check.require(CanonicalJson.stringify(record[key]) === CanonicalJson.stringify(previous[key]), 'PLUGIN_INTENT_CHANGED');
        for (const key of ['resolution', 'sourceReceipt'] as const)
            if (previous[key] !== null)
                Check.require(CanonicalJson.stringify(record[key]) === CanonicalJson.stringify(previous[key]), 'PLUGIN_SOURCE_CHANGED');
        Check.require(!['active', 'blocked', 'recovery-required'].includes(previous.stage), 'PLUGIN_TERMINAL_REQUEST');
        const transitions: Record<string, string[]> = { received: ['resolving', 'blocked'], resolving: ['resolved', 'blocked', 'recovery-required'], resolved: ['acquired', 'blocked', 'recovery-required'], acquired: ['prepared', 'pending', 'active', 'blocked', 'recovery-required'], prepared: ['pending', 'active', 'blocked', 'recovery-required'], pending: ['pending', 'active', 'blocked', 'recovery-required'] };
        Check.require(transitions[previous.stage]?.includes(record.stage), 'PLUGIN_STAGE_TRANSITION');
        if (['acquired', 'prepared', 'pending', 'active'].includes(record.stage))
            Check.require(record.sourceReceipt !== null, 'PLUGIN_SOURCE_REQUIRED');
        if (['prepared', 'pending', 'active', 'blocked', 'recovery-required'].includes(record.stage)) {
            Check.require(record.result !== null && (record.stage === 'active' ? ['active', 'already-active'].includes(record.result.state) : record.result.state === record.stage), 'PLUGIN_RESULT_STAGE');
        }
        if (['received', 'resolving'].includes(record.stage))
            Check.require(record.resolution === null && record.sourceReceipt === null && record.result === null, 'PLUGIN_PREMATURE_SOURCE');
        if (!['prepared', 'pending', 'active', 'blocked', 'recovery-required'].includes(record.stage))
            Check.require(record.result === null, 'PLUGIN_PREMATURE_RESULT');
        if (record.result?.artifact && record.sourceReceipt)
            Check.require(record.result.artifact.package === record.sourceReceipt.name && record.result.artifact.version === record.sourceReceipt.version && record.result.artifact.integrity === record.sourceReceipt.archiveDigest, 'PLUGIN_RESULT_ARTIFACT');
        if (record.resolution) {
            if (record.operation === 'install') {
                const locator = PluginSource.parse((record.intent as PluginInstallRequest).source);
                Check.require(locator.kind === record.resolution.kind, 'PLUGIN_SOURCE_CHANGED');
                if (locator.kind === 'npm' && record.resolution.kind === 'npm')
                    Check.require(locator.name === record.resolution.name, 'PLUGIN_SOURCE_CHANGED');
                if (locator.kind === 'git' && record.resolution.kind === 'git')
                    Check.require(locator.url === record.resolution.origin, 'PLUGIN_SOURCE_CHANGED');
            }
        }
        if (record.sourceReceipt) {
            const source = record.sourceReceipt, resolution = record.resolution;
            Check.require(resolution && resolution.kind === source.kind, 'PLUGIN_SOURCE_CHANGED');
            if (source.kind === 'npm' && resolution.kind === 'npm')
                Check.require(source.registry === resolution.registry && source.name === resolution.name && source.version === resolution.version && source.sri === resolution.sri, 'PLUGIN_SOURCE_CHANGED');
            if (source.kind === 'git' && resolution.kind === 'git')
                Check.require(source.origin === resolution.origin && source.commit === resolution.commit, 'PLUGIN_SOURCE_CHANGED');
            Check.require(CanonicalJson.stringify(source.helperDigests) === CanonicalJson.stringify(resolution.helperDigests), 'PLUGIN_SOURCE_CHANGED');
            if (record.operation === 'install')
                Check.require(source.locator === (record.intent as PluginInstallRequest).source, 'PLUGIN_SOURCE_CHANGED');
        }
    }
}
/** Caller must hold the installation's actual writer; no lock acquisition or stealing here. */
export class PluginRequestStore {
    private readonly plan: ServicePlan;
    constructor(plan: ServicePlan, private readonly writer: InstallationWriter) { this.plan = ServiceSchemas.plan.parse(plan); this.writer.assert(this.plan.configuration.installationDirectory); }
    private state(): SafeDirectory {
        this.writer.assert(this.plan.configuration.installationDirectory);
        const root = SafeDirectory.open(this.plan.configuration.installationDirectory);
        try {
            const state = root.directory('.cordis', true);
            try {
                SafeDirectory.owner(fstatSync(state.fd), true);
                const parsed = ServiceSchemas.receipt.safeParse(StrictJson.parse(state.file('installation.json', undefined, 4 * 1024 * 1024, true)));
                Check.require(parsed.success && parsed.data.installationId === this.plan.configuration.installationId && parsed.data.installationDirectory === root.path && parsed.data.ownerUid === process.getuid?.() && CanonicalJson.stringify(parsed.data.expectedEngine) === CanonicalJson.stringify(this.plan.expectedEngine), 'PLUGIN_REQUEST_SCOPE');
                return state;
            }
            catch (error) {
                state.close();
                throw error;
            }
        }
        finally {
            root.close();
        }
    }
    records(): PluginRequestRecord[] {
        const state = this.state();
        try {
            return PluginRequestJournal.read(state, this.plan.configuration).records;
        }
        finally {
            state.close();
        }
    }
    begin(input: PluginInstallRequest | PluginSelectRequest, policyDigest: string, expectedGeneration: string | null): {
        record: PluginRequestRecord;
        fresh: boolean;
    } {
        const operation = Object.hasOwn(input, 'source') ? 'install' : 'select', intent = operation === 'install' ? PluginManagementSchemas.install.parse(input) : PluginManagementSchemas.select.parse(input);
        PlatformSchemas.digest.parse(policyDigest);
        if (expectedGeneration !== null)
            PlatformSchemas.digest.parse(expectedGeneration);
        Check.require(intent.installationDirectory === this.plan.configuration.installationDirectory, 'PLUGIN_REQUEST_SCOPE');
        const intentDigest = CanonicalJson.digest(intent);
        for (const record of this.records())
            if (record.requestId === intent.idempotencyKey) {
                Check.require(record.intentDigest === intentDigest && record.policyDigest === policyDigest, 'IDEMPOTENCY_CONFLICT');
                return { record, fresh: false };
            }
        Check.require(intent.expectedGeneration === undefined || intent.expectedGeneration === expectedGeneration, 'STALE_GENERATION');
        const record = ServiceWorkerSchemas.requestRecord.parse({ formatVersion: 1, requestId: intent.idempotencyKey, installationId: this.plan.configuration.installationId, installationDirectory: this.plan.configuration.installationDirectory, sequence: 0, operation, intent, intentDigest, expectedGeneration, policyDigest, stage: 'received', resolution: null, sourceReceipt: null, result: null });
        return { record: this.append(record), fresh: true };
    }
    append(input: PluginRequestRecord): PluginRequestRecord {
        const record = ServiceWorkerSchemas.requestRecord.parse(input), state = this.state();
        try {
            const before = PluginRequestJournal.read(state, this.plan.configuration), event: RequestEvent = { formatVersion: 1, previousDigest: before.digest, record };
            PluginRequestJournal.read(state, this.plan.configuration, event);
            this.writer.assert(this.plan.configuration.installationDirectory);
            let plugins: SafeDirectory;
            if (state.entries().includes('plugins'))
                plugins = state.directory('plugins', true);
            else
                plugins = InstallationStore.mkdir(state, 'plugins');
            try {
                let directory: SafeDirectory;
                if (plugins.entries().includes('requests'))
                    directory = plugins.directory('requests', true);
                else
                    directory = InstallationStore.mkdir(plugins, 'requests');
                try {
                    InstallationStore.publish(directory, PluginRequestJournal.name(event, before.count), event);
                    directory.verify();
                }
                finally {
                    directory.close();
                }
                const head = PluginRequestJournal.head.parse({ formatVersion: 1, count: before.count + 1, digest: CanonicalJson.digest(event) });
                if (before.count === 0)
                    InstallationStore.publish(plugins, 'head.json', head);
                else {
                    const expected = CanonicalJson.stringify({ formatVersion: 1, count: before.count, digest: before.digest }) + '\n';
                    Check.require(plugins.file('head.json', undefined, 1024, true).toString('utf8') === expected, 'PLUGIN_JOURNAL_HEAD');
                    const temporary = '.head-' + randomUUID();
                    InstallationStore.publish(plugins, temporary, head);
                    this.writer.assert(this.plan.configuration.installationDirectory);
                    plugins.verify();
                    Check.require(plugins.file('head.json', undefined, 1024, true).toString('utf8') === expected, 'PLUGIN_JOURNAL_HEAD');
                    renameSync(plugins.childPath(temporary), plugins.childPath('head.json'));
                    fsyncSync(plugins.fd);
                }
                plugins.verify();
            }
            finally {
                plugins.close();
            }
            const after = PluginRequestJournal.read(state, this.plan.configuration);
            Check.require(after.count === before.count + 1 && after.digest === CanonicalJson.digest(event), 'PLUGIN_PUBLICATION_FAILED');
            this.writer.assert(this.plan.configuration.installationDirectory);
            return record;
        }
        finally {
            state.close();
        }
    }
}

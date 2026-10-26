import { MigrationArtifacts } from './migration-artifacts.js';
import { linkSync, unlinkSync, lstatSync, fsyncSync } from 'node:fs';
import { CanonicalJson, ServiceSchemas, InstalledSchemas, type InstalledPlan } from '@treeseed-cordis/sdk';
import { InstallationStore } from './installed.js';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';
import { MigrationCustody, MigrationSchemas, type Format2MigrationRequest, type Format2MigrationResult } from './migration-custody.js';
import { MigrationRuntime } from './migration-runtime.js';
/** Explicit owner-local format change. Never called by plan, install, apply or status. */
export class Format2Migration {
    static read(path: string): Format2MigrationResult { return MigrationCustody.read(path).result; }
    private static plan(state: SafeDirectory, digest: string): InstalledPlan { const plan = InstalledSchemas.plan.parse(StrictJson.parse(state.file('plans/plan-' + digest + '.json', undefined, 4 * 1024 * 1024, true))), { id, digest: stored, ...payload } = plan; Check.require(stored === digest && id === 'plan-' + digest && CanonicalJson.digest(payload) === digest && plan.configuration.installationDirectory === state.path.slice(0, -'/.cordis'.length), 'PLAN_BINDING'); return plan; }
    static async run(path: string, input: Format2MigrationRequest): Promise<Format2MigrationResult> {
        const parsed = MigrationSchemas.request.safeParse(input);
        Check.require(parsed.success, 'MIGRATION_AUTHORIZATION_REQUIRED');
        const request = parsed.data;
        let root: SafeDirectory;
        try {
            root = SafeDirectory.open(path);
        }
        catch {
            return Check.block('MIGRATION_NOT_REQUIRED');
        }
        try {
            Check.require(root.entries().join(',') === '.cordis', 'MIGRATION_NOT_REQUIRED');
            const state = root.directory('.cordis', true);
            try {
                if (state.entries().includes(MigrationCustody.directory)) {
                    const saved = MigrationCustody.read(path);
                    Check.require(CanonicalJson.stringify(saved.intent.request) === CanonicalJson.stringify(request), 'MIGRATION_CONFLICT');
                    const plan = this.plan(state, request.expectedComposition), runtime = await new MigrationRuntime(plan, state).inspect(), privateResources = MigrationCustody.privateResources(plan, state), resources = [...runtime, ...privateResources].sort(this.order);
                    Check.require(CanonicalJson.stringify(resources) === CanonicalJson.stringify(saved.intent.resources), 'MIGRATION_RESOURCE_IDENTITY');
                    return saved.result;
                }
                const store = new InstallationStore(path);
                Check.require(store.inspect() === 'installed', 'MIGRATION_NOT_REQUIRED');
                const records = store.records();
                Check.require(records.length > 0, 'MIGRATION_ACTIVE_HISTORY_REQUIRED');
                for (const record of records)
                    Check.require(record.phase === 'completed' && record.result === 'ready' && record.recovery === null && record.activeComposition === request.expectedComposition, 'MIGRATION_UNCERTAIN_HISTORY');
                const plan = store.read('plan-' + request.expectedComposition, request.expectedComposition);
                Check.require(plan.configuration.runtimeState === 'running', 'MIGRATION_ACTIVE_HISTORY_REQUIRED');
                Check.require(!state.entries().includes('writer.lock'), 'MIGRATION_NON_SERVING_REQUIRED');
                const before = MigrationCustody.files(state);
                MigrationArtifacts.verify(plan, state, before);
                const resources = [...await new MigrationRuntime(plan, state).inspect(), ...MigrationCustody.privateResources(plan, state)].sort(this.order);
                const writer = store.writer();
                try {
                    writer.assert(path);
                    Check.require(CanonicalJson.stringify(MigrationCustody.files(state)) === CanonicalJson.stringify(before), 'MIGRATION_CUSTODY_CHANGED');
                    const second = [...await new MigrationRuntime(plan, state).inspect(), ...MigrationCustody.privateResources(plan, state)].sort(this.order);
                    Check.require(CanonicalJson.stringify(second) === CanonicalJson.stringify(resources), 'MIGRATION_RESOURCE_IDENTITY');
                    const original = state.file('installation.json', undefined, 4 * 1024 * 1024, true), receipt = ServiceSchemas.receipt.parse({ ...InstalledSchemas.receipt.parse(StrictJson.parse(original)), formatVersion: 3, migration: { from: 2, receiptSha256: MigrationCustody.sha(original), previousComposition: plan.digest, nonServingProof: CanonicalJson.digest({ expectedEngine: plan.expectedEngine, resources, stopped: true }), compatibilityProof: CanonicalJson.digest({ files: before, resources }) } }), intent = MigrationSchemas.intent.parse({ formatVersion: 1, request, receipt, files: before, resources });
                    const directory = InstallationStore.mkdir(state, MigrationCustody.directory);
                    try {
                        InstallationStore.publish(directory, 'intent.json', intent);
                        writer.assert(path);
                        state.file('installation.json', receipt.migration!.receiptSha256, 4 * 1024 * 1024, true);
                        Check.require(CanonicalJson.stringify(MigrationCustody.files(state)) === CanonicalJson.stringify(before), 'MIGRATION_CUSTODY_CHANGED');
                        const originalIdentity = before.find(Format2Migration.original), source = lstatSync(state.childPath('installation.json'));
                        Check.require(originalIdentity && source.dev === originalIdentity.dev && source.ino === originalIdentity.ino, 'MIGRATION_CUSTODY_CHANGED');
                        linkSync(state.childPath('installation.json'), directory.childPath('installation-format2.json'));
                        fsyncSync(directory.fd);
                        const retained = lstatSync(directory.childPath('installation-format2.json')), linked = lstatSync(state.childPath('installation.json'));
                        Check.require(retained.dev === source.dev && retained.ino === source.ino && linked.dev === source.dev && linked.ino === source.ino && retained.nlink === 2 && linked.nlink === 2, 'MIGRATION_CUSTODY_CHANGED');
                        unlinkSync(state.childPath('installation.json'));
                        fsyncSync(state.fd);
                        directory.file('installation-format2.json', receipt.migration!.receiptSha256, 4 * 1024 * 1024, true);
                        InstallationStore.publish(directory, 'complete.json', { formatVersion: 1, intentDigest: CanonicalJson.digest(intent), receiptDigest: CanonicalJson.digest(receipt) });
                        writer.assert(path);
                        InstallationStore.publish(state, 'installation.json', receipt);
                        root.verify();
                        state.verify();
                    }
                    finally {
                        directory.close();
                    }
                }
                finally {
                    writer.close();
                }
                return this.read(path);
            }
            finally {
                state.close();
            }
        }
        catch (error) {
            if ((error as {
                code?: string;
            }).code === 'ENOENT')
                return Check.block('MIGRATION_NOT_REQUIRED');
            throw error;
        }
        finally {
            root.close();
        }
    }
    private static original(file: {
        path: string;
    }): boolean { return file.path === 'installation.json'; }
    private static order(left: {
        resourceId: string;
    }, right: {
        resourceId: string;
    }): number { return left.resourceId < right.resourceId ? -1 : left.resourceId > right.resourceId ? 1 : 0; }
}

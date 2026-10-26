import { z } from 'zod';
import { createHash, X509Certificate } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { CanonicalJson, PlatformSchemas, ServiceSchemas, InstalledSchemas, type InstalledPlan, type ServiceResourceReceipt } from '@treeseed-cordis/sdk';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';
export class MigrationSchemas {
    static readonly request = z.strictObject({ from: z.literal(2), expectedComposition: PlatformSchemas.digest, authorization: z.literal('non-serving') });
    static readonly file = z.strictObject({ path: PlatformSchemas.relative, kind: z.enum(['file', 'directory']), mode: z.number().int(), dev: z.number().int().nonnegative(), ino: z.number().int().nonnegative(), size: z.number().int().nonnegative(), sha256: PlatformSchemas.digest.nullable() });
    static readonly intent = z.strictObject({ formatVersion: z.literal(1), request: this.request, receipt: ServiceSchemas.receipt, files: z.array(this.file).min(1).max(100000), resources: z.array(ServiceSchemas.resourceReceipt).min(5).max(10000) });
    static readonly complete = z.strictObject({ formatVersion: z.literal(1), intentDigest: PlatformSchemas.digest, receiptDigest: PlatformSchemas.digest });
}
export type Format2MigrationRequest = z.infer<typeof MigrationSchemas.request>;
export interface Format2MigrationResult {
    formatVersion: 3;
    state: 'migrated';
    runtime: 'unverified';
    activeComposition: null;
    previousComposition: string;
    resources: ServiceResourceReceipt[];
    nextActions: [
        'review-runtime-migration'
    ];
}
/** Private historical evidence, deliberately separate from the live format-3 application journal. */
export class MigrationCustody {
    static schema<T>(schema: {
        safeParse(value: unknown): {
            success: boolean;
            data?: T;
        };
    }, value: unknown): T { const result = schema.safeParse(value); Check.require(result.success, 'INVALID_MIGRATION'); return result.data!; }
    static readonly directory = 'migration-2-to-3';
    static sha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
    static files(state: SafeDirectory, migrated = false, prefix = '', result: z.infer<typeof MigrationSchemas.file>[] = [], budget = { bytes: 0 }): z.infer<typeof MigrationSchemas.file>[] { Check.require(prefix.split('/').length <= 64, 'MIGRATION_INVENTORY_LIMIT'); for (const name of state.entries()) {
        if (!prefix && [this.directory, 'writer.lock', 'installation.json'].includes(name))
            continue;
        const path = prefix + name, stat = lstatSync(state.childPath(name));
        Check.require(!stat.isSymbolicLink() && stat.uid === process.getuid?.() && result.length < 100000, 'MIGRATION_FILE_SCOPE');
        const mode = stat.mode & 0o777;
        Check.require(stat.isDirectory() ? [0o500, 0o700].includes(mode) : stat.isFile() && stat.nlink === 1 && ([0o400, 0o600].includes(mode) || (path === 'worker' && [0o500, 0o700].includes(mode))), 'MIGRATION_FILE_SCOPE');
        if (stat.isDirectory()) {
            result.push({ path, kind: 'directory', mode, dev: stat.dev, ino: stat.ino, size: 0, sha256: null });
            const child = state.directory(name);
            try {
                this.files(child, migrated, path + '/', result, budget);
            }
            finally {
                child.close();
            }
        }
        else {
            Check.require(stat.size <= 512 * 1024 * 1024 && (budget.bytes += stat.size) <= 8 * 1024 ** 3, 'MIGRATION_INVENTORY_LIMIT');
            const bytes = state.file(name, undefined, 512 * 1024 * 1024), after = lstatSync(state.childPath(name));
            Check.require(stat.dev === after.dev && stat.ino === after.ino && stat.mode === after.mode && stat.mtimeMs === after.mtimeMs && stat.ctimeMs === after.ctimeMs, 'FILE_CHANGED');
            result.push({ path, kind: 'file', mode, dev: stat.dev, ino: stat.ino, size: stat.size, sha256: this.sha(bytes) });
        }
    } if (!prefix) {
        let directory = state;
        try {
            if (migrated)
                directory = state.directory(this.directory, true);
            const name = migrated ? 'installation-format2.json' : 'installation.json', bytes = directory.file(name, undefined, 4 * 1024 * 1024, true), stat = lstatSync(directory.childPath(name));
            result.push({ path: 'installation.json', kind: 'file', mode: stat.mode & 0o777, dev: stat.dev, ino: stat.ino, size: stat.size, sha256: this.sha(bytes) });
        }
        finally {
            if (directory !== state)
                directory.close();
        }
        result.sort(this.order);
    } state.verify(); return result; }
    private static order(left: {
        path: string;
    }, right: {
        path: string;
    }): number { return left.path < right.path ? -1 : left.path > right.path ? 1 : 0; }
    static privateResources(plan: InstalledPlan, state: SafeDirectory): ServiceResourceReceipt[] { const credentials = state.directory('credentials', true), run = state.directory('run', true), result: ServiceResourceReceipt[] = []; try {
        const receipt = StrictJson.object(StrictJson.parse(credentials.file('_receipt.json', undefined, 1024 * 1024, true))), files = StrictJson.object(receipt.files);
        Check.require(receipt.planDigest === plan.digest && receipt.ownerUid === process.getuid?.() && CanonicalJson.stringify(credentials.entries()) === CanonicalJson.stringify([...Object.keys(files), '_receipt.json'].sort()), 'MIGRATION_CREDENTIAL_SCOPE');
        const declared = new Set<string>();
        for (const service of plan.composition.services)
            for (const name of Object.keys(service.definition.slots))
                declared.add(name);
        Check.require(CanonicalJson.stringify([...declared].sort()) === CanonicalJson.stringify(Object.keys(files).sort()), 'MIGRATION_CREDENTIAL_SCOPE');
        for (const [name, hash] of Object.entries(files)) {
            Check.require(PlatformSchemas.slot.safeParse(name).success && PlatformSchemas.digest.safeParse(hash).success, 'MIGRATION_CREDENTIAL_SCOPE');
            credentials.file(name, String(hash), 4 * 1024 * 1024, true);
            const owners = new Set<InstalledPlan['composition']['services'][number]['role']>();
            let definition: unknown = null;
            for (const service of plan.composition.services)
                if (Object.hasOwn(service.definition.slots, name)) {
                    if (definition !== null)
                        Check.require(CanonicalJson.stringify(definition) === CanonicalJson.stringify(service.definition.slots[name]), 'MIGRATION_CREDENTIAL_SCOPE');
                    definition = service.definition.slots[name];
                    owners.add(service.role);
                }
            const kind = StrictJson.object(definition).kind, resultKind = kind === 'random' || kind === 'uuid' ? 'secret' : 'configuration';
            result.push(this.privateReceipt(plan, resultKind, name, owners.size === 1 ? [...owners][0]! : null, definition, String(hash), 'credentials/' + name));
        }
        const authority = run.file('authority.pem', undefined, 1024 * 1024, true);
        Check.require(new X509Certificate(authority).ca, 'MIGRATION_AUTHORITY_SCOPE');
        result.push(this.privateReceipt(plan, 'authority', 'public-ca', 'edge', { kind: 'legacy-caddy-ca' }, this.sha(authority), 'run/authority.pem'));
        return result;
    }
    finally {
        run.close();
        credentials.close();
    } }
    private static privateReceipt(plan: InstalledPlan, kind: ServiceResourceReceipt['kind'], name: string, serviceId: InstalledPlan['composition']['services'][number]['role'] | null, definition: unknown, contentDigest: string, path: string): ServiceResourceReceipt { const scope = { installationId: plan.configuration.installationId, installationDirectory: plan.configuration.installationDirectory }, definitionDigest = CanonicalJson.digest(definition); return ServiceSchemas.resourceReceipt.parse({ ...scope, formatVersion: 3, resourceId: CanonicalJson.digest({ ...scope, kind, name, serviceId, definitionDigest }), kind, name, serviceId, creatingGeneration: plan.digest, definitionDigest, references: [plan.digest], actualId: null, contentDigest, imageDigest: null, path, ownerUid: process.getuid!(), legacy: { formatVersion: 2, planDigest: plan.digest, serviceId } }); }
    static read(path: string): {
        intent: z.infer<typeof MigrationSchemas.intent>;
        result: Format2MigrationResult;
    } { const root = SafeDirectory.open(path); try {
        Check.require(root.entries().join(',') === '.cordis', 'FOREIGN_INSTALLATION');
        const state = root.directory('.cordis', true);
        try {
            Check.require(!state.entries().includes('writer.lock'), 'MIGRATION_REPAIR_REQUIRED');
            const directory = state.directory(this.directory, true);
            try {
                Check.require(directory.entries().join(',') === 'complete.json,installation-format2.json,intent.json', 'MIGRATION_REPAIR_REQUIRED');
                const intent = this.schema(MigrationSchemas.intent, StrictJson.parse(directory.file('intent.json', undefined, 4 * 1024 * 1024, true))), complete = this.schema(MigrationSchemas.complete, StrictJson.parse(directory.file('complete.json', undefined, 1024, true))), receipt = this.schema(ServiceSchemas.receipt, StrictJson.parse(state.file('installation.json', undefined, 4 * 1024 * 1024, true))), oldBytes = directory.file('installation-format2.json', receipt.migration?.receiptSha256, 4 * 1024 * 1024, true), old = this.schema(InstalledSchemas.receipt, StrictJson.parse(oldBytes));
                Check.require(receipt.migration && receipt.installationDirectory === path && receipt.ownerUid === process.getuid?.() && CanonicalJson.stringify(receipt) === CanonicalJson.stringify(intent.receipt) && CanonicalJson.digest(intent) === complete.intentDigest && CanonicalJson.digest(receipt) === complete.receiptDigest, 'INVALID_MIGRATION');
                Check.require(old.installationId === receipt.installationId && old.installationDirectory === path && old.ownerUid === receipt.ownerUid && CanonicalJson.stringify(old.expectedEngine) === CanonicalJson.stringify(receipt.expectedEngine) && receipt.migration.previousComposition === intent.request.expectedComposition && receipt.migration.nonServingProof === CanonicalJson.digest({ expectedEngine: receipt.expectedEngine, resources: intent.resources, stopped: true }) && receipt.migration.compatibilityProof === CanonicalJson.digest({ files: intent.files, resources: intent.resources }), 'INVALID_MIGRATION');
                Check.require(CanonicalJson.stringify(this.files(state, true)) === CanonicalJson.stringify(intent.files), 'MIGRATION_CUSTODY_CHANGED');
                for (const resource of intent.resources)
                    Check.require(resource.installationId === receipt.installationId && resource.installationDirectory === path && resource.ownerUid === receipt.ownerUid && resource.legacy?.planDigest === receipt.migration.previousComposition && resource.creatingGeneration === receipt.migration.previousComposition && CanonicalJson.stringify(resource.references) === CanonicalJson.stringify([receipt.migration.previousComposition]), 'INVALID_MIGRATION');
                const ids = new Set<string>();
                for (const resource of intent.resources) {
                    Check.require(!ids.has(resource.resourceId), 'INVALID_MIGRATION');
                    ids.add(resource.resourceId);
                }
                return { intent, result: { formatVersion: 3, state: 'migrated', runtime: 'unverified', activeComposition: null, previousComposition: receipt.migration.previousComposition, resources: intent.resources, nextActions: ['review-runtime-migration'] } };
            }
            finally {
                directory.close();
            }
        }
        finally {
            state.close();
        }
    }
    finally {
        root.close();
    } }
}

import { resolve, join } from 'node:path';
import { CanonicalJson, PlatformSchemas, PluginManagementSchemas, ServiceSchemas, type PluginInstallRequest, type PluginInstallResult, type PluginRequestRecord } from '@treeseed-cordis/sdk';
import type { PluginManager } from './plugin-manager.js';
import { PluginRequestJournal } from './plugin-registry.js';
import { ServicePlanStore } from './service-plan.js';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';

/** Read-only accepted data. Never starts/adopts an owner or infers current runtime health. */
export class PluginRegistryReader implements Pick<PluginManager, 'list' | 'inspect'> {
    private readonly path: string;
    constructor(path: string) { PlatformSchemas.absolute.parse(path); this.path = resolve(path); Check.require(this.path === path, 'PLUGIN_REQUEST_SCOPE'); }
    private records(): PluginRequestRecord[] {
        Check.require(new ServicePlanStore(this.path).inspect(), 'MISSING_JOURNAL');
        const state = SafeDirectory.open(join(this.path, '.cordis'));
        try {
            const receipt = ServiceSchemas.receipt.parse(StrictJson.parse(state.file('installation.json', undefined, 4 * 1024 * 1024, true)));
            Check.require(receipt.installationDirectory === this.path && receipt.ownerUid === process.getuid?.(), 'PLUGIN_REQUEST_SCOPE');
            return PluginRequestJournal.read(state, receipt).records;
        } finally { state.close(); }
    }
    private static project(record: PluginRequestRecord): PluginInstallResult {
        if (record.result && !['active', 'already-active'].includes(record.result.state)) return PluginManagementSchemas.result.parse(record.result);
        const base = record.result ?? { requestId: record.requestId, pluginId: null, artifact: null, target: record.intent.target ?? null, planId: null, applicationId: null, previousGeneration: record.expectedGeneration };
        return PluginManagementSchemas.result.parse({ ...base, activeGeneration: null, state: 'recovery-required', blockers: [{ code: 'OWNER_READBACK_REQUIRED', message: 'Stored records do not establish current runtime health. Inspect the owner or explicitly repair the unfinished request.' }], nextActions: ['inspect-owner'], acknowledgements: [] });
    }
    async inspect(requestId: string): Promise<PluginInstallResult> { requestId = PluginManagementSchemas.key.parse(requestId); for (const record of this.records()) if (record.requestId === requestId) return PluginRegistryReader.project(record); return Check.block('PLUGIN_REQUEST_NOT_FOUND'); }
    async list(scope: PluginInstallRequest['scope'] = 'installation', target?: PluginInstallRequest['target']): Promise<PluginInstallResult[]> {
        PluginManagementSchemas.scope.parse(scope); Check.require(scope === 'installation', 'PLUGIN_SCOPE_NOT_SUPPORTED'); if (target !== undefined) PluginManagementSchemas.target.parse(target);
        const result: PluginInstallResult[] = [];
        for (const record of this.records()) if (record.intent.scope === scope && (target === undefined || record.intent.target === target || record.result?.target === target)) result.push(PluginRegistryReader.project(record));
        Check.require(CanonicalJson.stringify(result).length <= 4 * 1024 * 1024, 'PLUGIN_REGISTRY_LIMIT'); return result;
    }
}

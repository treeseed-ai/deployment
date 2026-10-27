import { resolve, join } from 'node:path';
import { PlatformSchemas, PluginManagementSchemas, type PluginInstallRequest, type PluginSelectRequest, type PluginInstallResult, type ServicePlan } from '@treeseed-cordis/sdk';
import { BootstrapSchemas } from './service-bootstrap.js';
import { ServiceInstalledHost } from './service-installed.js';
import { ServicePlanStore } from './service-plan.js';
import { PluginRegistryReader } from './plugin-reader.js';
import type { PluginManager } from './plugin-manager.js';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';
/** Transport/bootstrap adapter only. The native durable owner retains all transition authority. */
export class InstalledPluginManager implements PluginManager {
    private readonly path: string;
    constructor(path: string) { PlatformSchemas.absolute.parse(path); this.path = resolve(path); Check.require(path === this.path, 'PLUGIN_REQUEST_SCOPE'); }
    private plan(): ServicePlan {
        const store = new ServicePlanStore(this.path);
        const state = SafeDirectory.open(join(this.path, '.cordis'));
        try {
            if (state.entries().includes('launch')) {
                const launch = state.directory('launch', true);
                try { const intent = BootstrapSchemas.intent.safeParse(StrictJson.parse(launch.file('intent.json', undefined, 4096, true))); Check.require(intent.success, 'BOOTSTRAP_REPAIR_REQUIRED'); return store.readPublished(intent.data.planId, intent.data.digest); }
                finally { launch.close(); }
            }
            Check.require(store.inspect(), 'MISSING_JOURNAL');
            Check.require(!state.entries().some(InstalledPluginManager.uncertain) && store.records().length === 0 && store.resources().length === 0, 'WORKER_REPAIR_REQUIRED');
            const plans = state.directory('plans', true);
            try { const names = plans.entries(); Check.require(names.length === 1, 'INITIAL_PLAN_AMBIGUOUS'); const match = /^plan-([a-f0-9]{64})\.json$/.exec(names[0]!); Check.require(match, 'INVALID_PLAN'); plans.verify(); state.verify(); return store.read('plan-' + match[1], match[1]!); }
            finally { plans.close(); }
        } finally { state.close(); }
    }
    private static uncertain(name: string): boolean { return ['writer.lock', 'run', 'control', 'worker'].includes(name); }
    private async owner() { const plan = this.plan(); return new ServiceInstalledHost().owner(plan.id, plan.digest, this.path); }
    async install(input: PluginInstallRequest): Promise<PluginInstallResult> {
        const request = PluginManagementSchemas.install.parse(input); Check.require(request.installationDirectory === this.path, 'PLUGIN_REQUEST_SCOPE');
        const plan = this.plan(); Check.require(plan.acquisitionPolicy, 'SOURCE_POLICY_REQUIRED');
        return (await new ServiceInstalledHost().owner(plan.id, plan.digest, this.path)).install(request);
    }
    async select(input: PluginSelectRequest): Promise<PluginInstallResult> { const request = PluginManagementSchemas.select.parse(input); Check.require(request.installationDirectory === this.path, 'PLUGIN_REQUEST_SCOPE'); return (await this.owner()).select(request); }
    private live(): boolean {
        const state = SafeDirectory.open(join(this.path, '.cordis'));
        try { if (!state.entries().includes('control')) return false; const control = state.directory('control', true); try { const names = control.entries(); Check.require(names.length === 0 || names.join(',') === 'worker.sock', 'WORKER_REPAIR_REQUIRED'); control.verify(); state.verify(); return names.length === 1; } finally { control.close(); } }
        finally { state.close(); }
    }
    async list(scope: PluginInstallRequest['scope'] = 'installation', target?: PluginInstallRequest['target']): Promise<PluginInstallResult[]> { return this.live() ? (await this.owner()).list(scope, target) : new PluginRegistryReader(this.path).list(scope, target); }
    async inspect(requestId: string): Promise<PluginInstallResult> { PluginManagementSchemas.key.parse(requestId); return this.live() ? (await this.owner()).inspect(requestId) : new PluginRegistryReader(this.path).inspect(requestId); }
}

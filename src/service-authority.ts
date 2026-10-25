import { CanonicalJson, CapabilityToken, ProviderV4Schemas, ServiceSchemas, type ServicePlan } from '@treeseed-cordis/sdk';
import { Context } from '@treeseed-cordis/sdk/runtime';
import { ServicePlanStore } from './service-plan.js';
import { InstallationWriter } from './installed.js';
import { PlanningFailure as Check } from './filesystem.js';
/** Host-private coherent custody. Never registered in an installed service/provider scope. */
export class InstallationAuthority {
    readonly store: ServicePlanStore;
    readonly writer: InstallationWriter;
    constructor(readonly plan: ServicePlan) { this.store = new ServicePlanStore(plan.configuration.installationDirectory); Check.require(CanonicalJson.stringify(this.store.read(plan.id, plan.digest)) === CanonicalJson.stringify(plan), 'PLAN_BINDING'); Check.require(this.store.records().length === 0 && this.store.resources().length === 0 && this.store.current() === null, 'WORKER_REPAIR_REQUIRED'); this.writer = this.store.writer(); }
    close(): void { this.writer.close(); }
}
class AuthorityAdapter {
    parse(value: unknown): InstallationAuthority { Check.require(value instanceof InstallationAuthority, 'INVALID_INSTALLATION_AUTHORITY'); return value; }
}
export class InstallationAuthorityToken {
    static readonly instance = new CapabilityToken<InstallationAuthority>('deployment.installation', ProviderV4Schemas.version, new AuthorityAdapter());
}
export class InstallationAuthorityPlugin {
    static readonly provide = [InstallationAuthorityToken.instance.id];
    static readonly inject: string[] = [];
    static readonly Config = ServiceSchemas.plan;
    static readonly declaration = ProviderV4Schemas.declaration.parse({ id: 'deployment.installation-authority', pluginId: 'deployment', capability: InstallationAuthorityToken.instance.id, contractVersion: ProviderV4Schemas.version, target: 'deployment', provide: this.provide, inject: this.inject });
    private readonly authority: InstallationAuthority;
    constructor(context: Context, plan: ServicePlan) { this.authority = new InstallationAuthority(ServiceSchemas.plan.parse(plan)); context.provide(InstallationAuthorityToken.instance.id, this.authority); context.effect(this.effect.bind(this)); }
    private effect(): () => void { return this.authority.close.bind(this.authority); }
}

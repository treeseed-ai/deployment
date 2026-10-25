import { ServiceSchemas, type ServicePlan, type ServiceInstance, type ServiceObservationContext } from '@treeseed-cordis/sdk';
import { PlanningFailure as Check } from './filesystem.js';
/** Accepted plan data only. This class does not acquire authority, inspect health or perform I/O. */
export class ServiceObservations {
    private readonly plan: ServicePlan;
    constructor(plan: ServicePlan) { this.plan = ServiceSchemas.plan.parse(plan); }
    private service(id: string): ServiceInstance { for (const service of this.plan.composition.services) if (service.serviceId === id) return service; return Check.block('SERVICE_SCOPE'); }
    private identity(id: string): ServiceObservationContext['identity'] {
        this.service(id);
        for (const change of this.plan.changes) if (change.serviceId === id) return { installationId: this.plan.configuration.installationId, serviceId: id, compositionGeneration: this.plan.compositionGeneration, serviceGeneration: change.serviceGeneration, assetDigest: this.plan.composition.assetDigest, origin: this.plan.configuration.origin, runtime: this.plan.runtimeBindings?.[id] ?? null };
        return Check.block('SERVICE_SCOPE');
    }
    context(id: string): ServiceObservationContext {
        Check.require(ServiceSchemas.serviceId.safeParse(id).success, 'SERVICE_SCOPE');
        const service = this.service(id), dependencies: ServiceObservationContext['dependencies'] = [];
        for (const dependency of service.dependencies) {
            let selected: ServiceInstance | undefined;
            for (const target of this.plan.composition.services) for (const binding of target.bindings) if (binding.bindingId === dependency.bindingId) {
                Check.require(!selected && binding.contractId === dependency.contractId && binding.contractVersion === dependency.contractVersion, 'SERVICE_BINDING_MISMATCH');
                selected = target;
            }
            Check.require(selected, 'SERVICE_BINDING_MISMATCH');
            const endpoints: Record<string, string> = {};
            for (const port of selected.definition.ports) endpoints[port.id] = 'tcp://' + selected.serviceId + ':' + port.target;
            dependencies.push({ ...dependency, identity: this.identity(selected.serviceId), endpoints });
        }
        dependencies.sort(ServiceObservations.order);
        return ServiceObservations.freeze(ServiceSchemas.observationContext.parse({ formatVersion: 1, identity: this.identity(id), dependencies }));
    }
    private static order(a: { port: string }, b: { port: string }): number { return a.port < b.port ? -1 : a.port > b.port ? 1 : 0; }
    private static freeze<T>(value: T): T { if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) this.freeze(child); Object.freeze(value); } return value; }
}

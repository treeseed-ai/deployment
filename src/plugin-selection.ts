import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { CanonicalJson, ServiceSchemas, PluginManagementSchemas, type PluginInstallRequest, type PluginPackageDescriptor, type PluginExportDescriptor, type ServiceGraph, type ServiceInstance, type ServicePlan, type PluginSourceReceipt } from '@treeseed-cordis/sdk';
import { ServiceProjection } from './service-projection.js';
import { ServicePlanIdentity } from './service-plan.js';
import { PlanningFailure as Check } from './filesystem.js';

export type ContainerSelection = { kind: 'selected'; graph: ServiceGraph; serviceId: string } | { kind: 'prepared'; actions: string[] };
/** Pure selection/projection data. Native Cordis still owns all provider construction/lifecycle. */
export class ContainerPluginSelection {
    private static action(action: string): ContainerSelection { return { kind: 'prepared', actions: [action] }; }
    private static configuration(provider: PluginExportDescriptor, input: Record<string, unknown>): Record<string, unknown> {
        const value = structuredClone(input);
        try { const compiler = new Ajv2020({ strict: true, allErrors: false, useDefaults: true, coerceTypes: false, removeAdditional: false }); addFormats(compiler); const validate = compiler.compile(provider.configurationSchema); Check.require(Reflect.get(validate, '$async') !== true && validate(value) === true, 'INVALID_PROVIDER_CONFIGURATION'); return value; }
        catch { return Check.block('INVALID_PROVIDER_CONFIGURATION'); }
    }
    private static reference(descriptor: PluginPackageDescriptor, provider: PluginExportDescriptor, source: PluginSourceReceipt): ServiceInstance['provider'] { return ServiceSchemas.provider.parse({ pluginId: descriptor.pluginId, providerId: provider.declaration.id, target: provider.declaration.target, package: { name: source.name, version: source.version, sha256: source.archiveDigest }, entry: provider.entry, classExport: provider.classExport, contractVersion: provider.declaration.contractVersion }); }
    private static mentions(service: ServiceInstance, name: string, digest: string): boolean { for (const reference of [service.provider, service.readiness.provider]) if (reference.package.name === name && reference.package.sha256 !== digest) return true; return false; }
    static resolve(base: ServicePlan, request: PluginInstallRequest, descriptor: PluginPackageDescriptor, source: PluginSourceReceipt, target: PluginInstallRequest['target'] | null): ContainerSelection {
        if (target !== 'deployment') return this.action('qualify-target');
        const containers: PluginExportDescriptor[] = [];
        for (const provider of descriptor.providers) if (provider.declaration.target === target && provider.declaration.capability === 'container.service' && (request.providerId === undefined || request.providerId === provider.declaration.id)) containers.push(provider);
        if (containers.length !== 1 || !containers[0]!.container) return this.action('select-provider');
        if (descriptor.assets.length || descriptor.runtimeImages?.length) return this.action('rebuild-assets-and-image');
        const provider = containers[0]!, declaration = provider.container!, probes: PluginExportDescriptor[] = [];
        for (const candidate of descriptor.providers) if (candidate.declaration.target === target && candidate.declaration.capability === 'probe.service' && candidate.probe?.observationContracts.includes(declaration.observationContract)) probes.push(candidate);
        if (probes.length !== 1 || !probes[0]!.probe || declaration.definition.ports.length !== 1 || probes[0]!.probe!.schemes.length !== 1) return this.action('select-readiness');
        const probe = probes[0]!, serviceId = request.serviceId ?? (ServiceSchemas.serviceId.safeParse(descriptor.pluginId).success ? descriptor.pluginId : 'plugin-' + CanonicalJson.digest(descriptor.pluginId).slice(0, 16));
        if (!PluginManagementSchemas.key.safeParse('installation:' + base.configuration.installationId + ':service:' + serviceId).success) return this.action('qualify-scope-identity');
        for (const selection of base.configuration.plugins) if (selection.id === descriptor.pluginId && selection.package !== descriptor.package.name) return this.action('choose-plugin-identity');
        for (const service of base.composition.services) if (service.serviceId !== serviceId && this.mentions(service, source.name, source.archiveDigest)) return this.action('coordinate-package-selection');
        for (const port of declaration.definition.ports) if (port.publication) return this.action('review-edge-configuration');
        if (declaration.definition.workerSocket) return this.action('review-host-grant');
        let image = false;
        for (const artifact of descriptor.images) if (artifact.id === declaration.definition.imageId) for (const existing of base.artifacts) if (existing.kind === 'image' && existing.reference === artifact.reference && existing.manifestDigest === artifact.manifestDigest) for (const service of base.composition.services) if (service.definition.imageId === artifact.id && base.recipe.services[service.serviceId]?.image === artifact.reference) image = true;
        if (!image) return this.action('review-image');
        const graph = structuredClone(base.composition), prior = graph.services.find(ContainerPluginSelection.named.bind(null, serviceId));
        if (prior) for (const binding of prior.bindings) if (graph.profile.requiredBindings.includes(binding.bindingId)) return this.action('review-root-transition');
        const bindings: ServiceInstance['bindings'] = [], dependencies: ServiceInstance['dependencies'] = [], supplied = request.bindings ?? {};
        const consumed = new Set<string>();
        for (const contract of declaration.providedContracts) { consumed.add(contract.port); bindings.push({ ...contract, bindingId: supplied[contract.port] ?? serviceId + '.' + contract.port }); }
        for (const contract of declaration.dependencies) { consumed.add(contract.port); const bindingId = supplied[contract.port]; if (!bindingId) return this.action('configure-bindings'); dependencies.push({ ...contract, bindingId }); }
        for (const port of Object.keys(supplied)) Check.require(consumed.has(port), 'UNKNOWN_SERVICE_BINDING');
        const configuration = this.configuration(provider, request.configuration), probeConfiguration = this.configuration(probe, {});
        const parsed = ServiceSchemas.service.safeParse({ serviceId, provider: this.reference(descriptor, provider, source), configuration, definition: { ...declaration.definition, environment: {} }, resources: { ...declaration.resources, grants: [] }, bindings, dependencies, transitionPolicy: declaration.transitionPolicy, readiness: { provider: this.reference(descriptor, probe, source), configuration: probeConfiguration, scheme: probe.probe!.schemes[0], endpoint: { serviceId, portId: declaration.definition.ports[0]!.id }, deadlineMs: Math.min(10000, probe.probe!.maximumDeadlineMs), observationContract: declaration.observationContract, credentialReferences: [] } });
        Check.require(parsed.success, 'INVALID_SERVICE_SELECTION'); const service = parsed.data;
        if (prior) graph.services.splice(graph.services.indexOf(prior), 1, service); else graph.services.push(service);
        const projection = ServiceProjection.resolve(service, declaration, graph, base.configuration); service.definition = projection.definition; service.resources = projection.resources;
        if (prior) for (const port of prior.definition.ports) if (port.publication) return this.action('review-edge-configuration');
        const valid = ServiceSchemas.graph.safeParse(graph); Check.require(valid.success, 'INVALID_SERVICE_SELECTION');
        return { kind: 'selected', graph: ServicePlanIdentity.graph(valid.data), serviceId };
    }
    private static named(id: string, service: ServiceInstance): boolean { return service.serviceId === id; }
}

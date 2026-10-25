import { ServiceProjectionSchemas, ServiceSchemas, type ContainerProjection, type ServiceGraph, type ServiceInstance } from '@treeseed-cordis/sdk';
import { PlanningFailure as Check } from './filesystem.js';

/** Materializes package-owned data, without importing a provider or opening credentials. */
export class ServiceProjection {
    private count = 0;
    private readonly references = new Map<string, Set<string>>();
    private slot: string | null = null;
    private constructor(private readonly service: ServiceInstance, private readonly projection: ContainerProjection, private readonly graph: ServiceGraph, private readonly configuration: ReturnType<typeof ServiceSchemas.configuration.parse>) { }
    static resolve(service: ServiceInstance, declaration: unknown, graph: ServiceGraph, configuration: unknown): Pick<ServiceInstance, 'definition' | 'resources'> {
        return new ServiceProjection(service, ServiceProjectionSchemas.container.parse(declaration), graph, ServiceSchemas.configuration.parse(configuration)).materialize();
    }
    private dependency(port: string): ServiceInstance {
        let result: ServiceInstance | undefined;
        for (const dependency of this.service.dependencies) if (dependency.port === port) {
            for (const service of this.graph.services) for (const binding of service.bindings) if (binding.bindingId === dependency.bindingId) {
                Check.require(!result && binding.contractId === dependency.contractId && binding.contractVersion === dependency.contractVersion, 'SERVICE_BINDING_MISMATCH');
                result = service;
            }
        }
        Check.require(result, 'SERVICE_BINDING_MISMATCH');
        return result;
    }
    private secret(input: unknown): { $secret: string } {
        const marker = ServiceProjectionSchemas.secret.parse({ $secret: input }).$secret;
        const target = 'dependencyPort' in marker ? this.dependency(marker.dependencyPort) : this.service;
        const slots = target === this.service ? this.projection.resources.slots : target.resources.slots;
        Check.require(Object.hasOwn(slots, marker.slot), 'INVALID_SECRET_REFERENCE');
        if ('dependencyPort' in marker) {
            let granted = false;
            for (const grant of this.projection.resources.grants) if (grant.dependencyPort === marker.dependencyPort && grant.slot === marker.slot) granted = true;
            Check.require(granted, 'UNGRANTED_SECRET_REFERENCE');
        } else if (this.slot) this.references.get(this.slot)!.add(marker.slot);
        return { $secret: 'secret://' + target.serviceId + '/' + marker.slot };
    }
    private endpoint(input: unknown): string | number {
        const marker = ServiceProjectionSchemas.endpoint.parse({ $endpoint: input }).$endpoint, target = this.dependency(marker.dependencyPort);
        let port: number | undefined;
        for (const item of target.definition.ports) if (item.id === marker.portId) { Check.require(port === undefined, 'SERVICE_BINDING_MISMATCH'); port = item.target; }
        Check.require(port !== undefined, 'SERVICE_BINDING_MISMATCH');
        if (marker.part === 'host') return target.serviceId;
        if (marker.part === 'port') return port;
        const authority = target.serviceId + ':' + port;
        return marker.part === 'authority' ? authority : marker.scheme + '://' + authority + marker.path;
    }
    private context(input: unknown): string | number {
        const key = ServiceProjectionSchemas.context.parse({ $context: input }).$context, origin = new URL(this.configuration.origin);
        switch (key) {
            case 'installationId': return this.configuration.installationId;
            case 'serviceId': return this.service.serviceId;
            case 'origin': return origin.origin;
            case 'hostname': return origin.hostname;
            case 'originAuthority': return origin.host;
            case 'originPort': return Number(origin.port || (origin.protocol === 'https:' ? 443 : 80));
            case 'ownerUid': { const uid = process.getuid?.(); Check.require(uid !== undefined, 'UNSUPPORTED_HOST'); return uid; }
            case 'assetDigest': return this.graph.assetDigest;
        }
    }
    private configurationValue(input: unknown): unknown {
        const keys = ServiceProjectionSchemas.configuration.parse({ $configuration: input }).$configuration;
        let value: unknown = this.service.configuration;
        for (const key of keys) { Check.require(value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key), 'INVALID_PROVIDER_CONFIGURATION'); value = (value as Record<string, unknown>)[key]; }
        // Validated configuration is data, never a second template language.
        this.literal(value, 0);
        return structuredClone(value);
    }
    private literal(value: unknown, depth: number): void {
        Check.require(depth <= 32 && ++this.count <= 100000, 'PROJECTION_LIMIT');
        if (typeof value === 'string') Check.require(!value.includes('\0') && !value.includes('${') && !value.includes('secret://'), 'INVALID_PROJECTION');
        else if (Array.isArray(value)) for (const entry of value) this.literal(entry, depth + 1);
        else if (value !== null && typeof value === 'object') for (const [key, entry] of Object.entries(value)) { Check.require(!key.startsWith('$') && !['__proto__', 'prototype', 'constructor'].includes(key), 'INVALID_PROJECTION'); this.literal(entry, depth + 1); }
    }
    private value(value: unknown, depth = 0): unknown {
        Check.require(depth <= 32 && ++this.count <= 100000, 'PROJECTION_LIMIT');
        if (Array.isArray(value)) { const result: unknown[] = []; for (const item of value) result.push(this.value(item, depth + 1)); return result; }
        if (value !== null && typeof value === 'object') {
            const object = value as Record<string, unknown>, keys = Object.keys(object);
            if (keys.length === 1) {
                if (Object.hasOwn(object, '$secret')) return this.secret(object.$secret);
                if (Object.hasOwn(object, '$endpoint')) return this.endpoint(object.$endpoint);
                if (Object.hasOwn(object, '$context')) return this.context(object.$context);
                if (Object.hasOwn(object, '$configuration')) return this.configurationValue(object.$configuration);
                if (Object.hasOwn(object, '$template')) { Check.require(Array.isArray(object.$template) && object.$template.length <= 256, 'INVALID_PROJECTION'); return { $template: this.value(object.$template, depth + 1) }; }
            }
            const result: Record<string, unknown> = {};
            for (const [key, item] of Object.entries(object)) { Check.require(!key.startsWith('$') && !['__proto__', 'prototype', 'constructor'].includes(key), 'INVALID_PROJECTION'); result[key] = this.value(item, depth + 1); }
            return result;
        }
        if (typeof value === 'string') Check.require(!value.includes('\0') && !value.includes('${') && !value.includes('secret://'), 'INVALID_PROJECTION');
        return value;
    }
    private visit(slot: string, visiting: Set<string>, visited: Set<string>): void {
        Check.require(!visiting.has(slot), 'SECRET_REFERENCE_CYCLE');
        if (visited.has(slot)) return;
        visiting.add(slot);
        for (const next of this.references.get(slot) ?? []) this.visit(next, visiting, visited);
        visiting.delete(slot); visited.add(slot);
    }
    private static authority(id: string, value: { id: string }): boolean { return id === value.id; }
    private materialize(): Pick<ServiceInstance, 'definition' | 'resources'> {
        const environment: Record<string, string> = {};
        for (const [key, input] of Object.entries(this.projection.definition.environment)) { const value = this.value(input); Check.require(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean', 'INVALID_PROJECTION'); environment[key] = String(value); }
        const slots: Record<string, unknown> = {}, grants: ServiceInstance['resources']['grants'] = [];
        for (const key of Object.keys(this.projection.resources.slots)) this.references.set(key, new Set());
        for (const [key, input] of Object.entries(this.projection.resources.slots)) { this.slot = key; slots[key] = this.value(input); }
        this.slot = null;
        const visited = new Set<string>(); for (const key of this.references.keys()) this.visit(key, new Set(), visited);
        for (const grant of this.projection.resources.grants) { const target = this.dependency(grant.dependencyPort); Check.require(Object.hasOwn(target.resources.slots, grant.slot) || target.resources.authorities.some(ServiceProjection.authority.bind(null, grant.slot)), 'INVALID_SECRET_REFERENCE'); grants.push({ serviceId: target.serviceId, slot: grant.slot }); }
        return { definition: ServiceSchemas.definition.parse({ ...this.projection.definition, environment }), resources: ServiceSchemas.service.shape.resources.parse({ ...this.projection.resources, slots, grants }) };
    }
}

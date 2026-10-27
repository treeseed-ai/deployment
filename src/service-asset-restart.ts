import { CanonicalJson, type ServicePlan, type ServiceInstance } from '@treeseed-cordis/sdk';
type ConfigurationValue = Exclude<ServiceInstance['resources']['slots'][string]['value'], undefined>;
/** Bounded existing assetDigest projection, not a general configuration or credential migration. */
export class AssetConfigurationRestart {
    static compatible(previous: ServicePlan, desired: ServicePlan, before: ServiceInstance, after: ServiceInstance): boolean {
        if (CanonicalJson.stringify(before.resources) === CanonicalJson.stringify(after.resources))
            return true;
        const old = previous.composition.assetDigest, next = desired.composition.assetDigest;
        if (old === next)
            return false;
        const projected = structuredClone(before.resources);
        let changes = 0;
        for (const [name, slot] of Object.entries(projected.slots)) {
            const following = after.resources.slots[name];
            if (!following)
                return false;
            if (CanonicalJson.stringify(slot) === CanonicalJson.stringify(following))
                continue;
            if (slot.kind !== 'json' || following.kind !== 'json' || slot.value === undefined || following.value === undefined)
                return false;
            const result = this.project(slot.value, old, next);
            if (result.changes === 0)
                return false;
            slot.value = result.value;
            changes += result.changes;
            const reference = 'secret://' + before.serviceId + '/' + name;
            for (const service of desired.composition.services)
                if (service.serviceId !== before.serviceId)
                    for (const candidate of Object.values(service.resources.slots))
                        if (this.references(candidate.value, reference))
                            return false;
        }
        return changes > 0 && CanonicalJson.stringify(projected) === CanonicalJson.stringify(after.resources);
    }
    private static project(value: ConfigurationValue, previous: string, next: string): {
        value: ConfigurationValue;
        changes: number;
    } { if (Array.isArray(value)) {
        const result: ConfigurationValue[] = [];
        let changes = 0;
        for (const item of value) {
            const projected = this.project(item, previous, next);
            result.push(projected.value);
            changes += projected.changes;
        }
        return { value: result, changes };
    } if (value && typeof value === 'object') {
        const result: Record<string, ConfigurationValue> = {};
        let changes = 0;
        for (const [key, item] of Object.entries(value)) {
            if (key === 'assetDigest' && item === previous) {
                result[key] = next;
                changes++;
            }
            else {
                const projected = this.project(item, previous, next);
                result[key] = projected.value;
                changes += projected.changes;
            }
        }
        return { value: result, changes };
    } return { value, changes: 0 }; }
    private static references(value: unknown, reference: string): boolean { if (Array.isArray(value)) {
        for (const item of value)
            if (this.references(item, reference))
                return true;
    }
    else if (value && typeof value === 'object') {
        const object = value as Record<string, unknown>;
        if (Object.keys(object).length === 1 && object.$secret === reference)
            return true;
        for (const item of Object.values(object))
            if (this.references(item, reference))
                return true;
    } return false; }
}

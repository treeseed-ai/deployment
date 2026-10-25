import { test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { ComposeDeploymentHost, ServiceApplicationRuntime, ServicePlanStore } from '@treeseed-cordis/deployment';
import { CanonicalJson } from '@treeseed-cordis/sdk';
import { ServiceObservations } from '../src/service-observation.js';
import { ServiceReleaseFixture } from './release-fixture.js';
class ObservationTests {
    async metadata(): Promise<void> { const fixture = await new ServiceReleaseFixture().withCredentials(); try {
        const plan = await new ComposeDeploymentHost().plan(fixture.configuration);
        if (plan.formatVersion !== 3) throw new Error('Wrong plan');
        const context = new ServiceObservations(plan).context('instance-2'), dependency = context.dependencies[0]!;
        expect(context.identity.serviceId).toBe('instance-2');
        expect(context.identity.runtime).toBe(null);
        expect(dependency.port).toBe('primary');
        expect(dependency.identity.serviceId).toBe('instance-0');
        expect(dependency.endpoints.http).toBe('tcp://instance-0:8080');
        expect(Object.isFrozen(context)).toBe(true); expect(Object.isFrozen(context.identity)).toBe(true);
        expect(Object.isFrozen(context.dependencies)).toBe(true); expect(Object.isFrozen(dependency)).toBe(true); expect(Object.isFrozen(dependency.identity)).toBe(true); expect(Object.isFrozen(dependency.endpoints)).toBe(true);
        expect(Reflect.set(context.identity, 'serviceId', 'foreign')).toBe(false);
        expect(CanonicalJson.stringify(context)).not.toContain('secret://');
        expect(CanonicalJson.stringify(context)).not.toContain(fixture.installation);
    } finally { fixture.close(); } }
    async unaccepted(): Promise<void> { const fixture = await new ServiceReleaseFixture().services(); let runtime: ServiceApplicationRuntime | undefined; try {
        const plan = await new ComposeDeploymentHost().plan(fixture.configuration);
        if (plan.formatVersion !== 3) throw new Error('Wrong plan');
        runtime = await ServiceApplicationRuntime.start(plan);
        const store = new ServicePlanStore(fixture.installation), before = CanonicalJson.stringify(store.records());
        await expect(runtime.observationContext('instance-0')).rejects.toThrow();
        expect(CanonicalJson.stringify(store.records())).toBe(before);
        expect(existsSync(fixture.installation + '/.cordis/artifacts')).toBe(false);
        expect(existsSync(fixture.installation + '/.cordis/credentials')).toBe(false);
    } finally { await runtime?.close(); fixture.close(); } }
}
const suite = new ObservationTests();
test('unit: accepted observation exposes frozen declared dependency metadata without credential or path authority', suite.metadata.bind(suite));
test('integration: default native host refuses unaccepted observations without creating store effects', suite.unaccepted.bind(suite));

import { DockerCommands } from '../../src/diagnose.js';
import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, statSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceReleaseFixture } from '../support/release-fixture.js';
import {ReadonlyCommands} from '../support/service-plan-test-support.js';
class ServicePlanTestsIntegration {

    async permissions(): Promise<void> { const fixture = await new ServiceReleaseFixture().services(); try {
        const { ComposeDeploymentHost } = await import('../../src/diagnose.js');
        const module = await import('../../src/service-plan.js') as unknown as {
            ServicePlanStore: new (path: string) => {
                read(id: string, digest: string): unknown;
            };
        }, plan = await new ComposeDeploymentHost().plan(fixture.configuration), file = join(fixture.installation, '.cordis/plans', plan.id + '.json');
        expect(statSync(join(fixture.installation, '.cordis')).mode & 0o777).toBe(0o700);
        chmodSync(file, 0o644);
        expect(new module.ServicePlanStore(fixture.installation).read.bind(new module.ServicePlanStore(fixture.installation), plan.id, plan.digest)).toThrow();
        chmodSync(file, 0o600);
        const bytes = readFileSync(file);
        writeFileSync(file, '{}');
        expect(new module.ServicePlanStore(fixture.installation).read.bind(new module.ServicePlanStore(fixture.installation), plan.id, plan.digest)).toThrow();
        writeFileSync(file, bytes);
        const report = await new ComposeDeploymentHost().diagnose({ installationDirectory: fixture.installation, port: 58443 });
        let validStorage = false;
        for (const check of report.checks)
            if (check.id === 'storage' && check.status === 'pass')
                validStorage = true;
        expect(validStorage).toBe(true);
    }
    finally {
        fixture.close();
    } }
}
class ServicePlanBoundaryTestsIntegration {

    async additive(): Promise<void> { const { ComposeDeploymentHost } = await import('../../src/diagnose.js'), { ServiceSchemas } = await import('@treeseed-cordis/sdk'), fixture = await new ServiceReleaseFixture().services(); try {
        const host = new ComposeDeploymentHost(), first = await host.plan(fixture.configuration);
        if (first.formatVersion !== 3)
            throw new Error('Not a service plan');
        const previous = fixture.release.composition.services[4]!, next = ServiceSchemas.service.parse({ ...previous, serviceId: 'instance-5', bindings: [{ port: 'http', bindingId: 'instance-5', contractId: 'fixture.echo', contractVersion: '1.0.0' }], readiness: { ...previous.readiness, endpoint: { serviceId: 'instance-5', portId: 'http' } } });
        fixture.release.composition.services.push(next);
        fixture.recipe.services['instance-5'] = { image: fixture.release.images[0]!.reference };
        fixture.refreshService();
        const second = await host.plan(fixture.configuration);
        if (second.formatVersion !== 3)
            throw new Error('Not a service plan');
        expect(second.compositionGeneration).not.toBe(first.compositionGeneration);
        for (const before of first.changes) {
            let after: string | undefined;
            for (const change of second.changes)
                if (change.serviceId === before.serviceId)
                    after = change.serviceGeneration;
            expect(after).toBe(before.serviceGeneration);
        }
        expect(existsSync(join(fixture.installation, '.cordis/credentials'))).toBe(false);
    }
    finally {
        fixture.close();
    } }

    async blocked(): Promise<void> { const { ComposeDeploymentHost } = await import('../../src/diagnose.js'), fixture = await new ServiceReleaseFixture().services(); try {
        fixture.configuration.credentialReferences = ['secret://instance-0/missing'];
        await expect(new ComposeDeploymentHost().plan(fixture.configuration)).rejects.toThrow();
        expect(existsSync(fixture.installation)).toBe(false);
    }
    finally {
        fixture.close();
    } }

    async migration(): Promise<void> { const { ComposeDeploymentHost } = await import('../../src/diagnose.js'), { PreparedReleaseFixture } = await import('../support/release-fixture.js'), legacy = await new PreparedReleaseFixture().prepare(), fixture = await new ServiceReleaseFixture().services(); try {
        await new ComposeDeploymentHost().plan(legacy.configuration);
        const path = join(legacy.installation, '.cordis/receipt.json'), before = readFileSync(path);
        fixture.configuration.installationDirectory = legacy.installation;
        try {
            await new ComposeDeploymentHost().plan(fixture.configuration);
            throw new Error('implicit migration');
        }
        catch (error) {
            expect(JSON.stringify(error)).toContain('MIGRATION_REQUIRED');
        }
        expect(readFileSync(path)).toEqual(before);
        expect(existsSync(join(legacy.installation, '.cordis/installation.json'))).toBe(false);
    }
    finally {
        legacy.close();
        fixture.close();
    } }
}
class ServiceCommandTestsIntegration {

    async readonly(): Promise<void> { const { ComposeDeploymentHost } = await import('../../src/diagnose.js'), fixture = await new ServiceReleaseFixture().services(), commands = new ReadonlyCommands(); try {
        const plan = await new ComposeDeploymentHost(commands).plan(fixture.configuration);
        expect(plan.formatVersion).toBe(3);
        expect(commands.calls).toBeGreaterThan(0);
    }
    finally {
        fixture.close();
    } }
}
const suite=new ServicePlanTestsIntegration();
const boundaries=new ServicePlanBoundaryTestsIntegration();
const commands=new ServiceCommandTestsIntegration();
test('integration: format3 plan read-back rejects malformed and non-private records and doctor recognizes the store', suite.permissions.bind(suite));
test('integration: unrelated private service additions preserve existing service generations', boundaries.additive.bind(boundaries));
test('integration: blocked generic plans create no journal state', boundaries.blocked.bind(boundaries));
test('integration: generic planning refuses implicit legacy migration and preserves old bytes', boundaries.migration.bind(boundaries));
test('integration: generic planner uses only read-only engine commands', commands.readonly.bind(commands));

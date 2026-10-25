import { DockerCommands } from '../src/diagnose.js';
import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, statSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceReleaseFixture } from './release-fixture.js';
class ServicePlanTests {
    async program(): Promise<void> { const fixture = await new ServiceReleaseFixture().services(); try {
        const request = join(fixture.root, 'request.json');
        writeFileSync(request, JSON.stringify(fixture.configuration));
        const result = spawnSync('node', ['dist/tests/service-plan-program.js', request], { encoding: 'utf8', timeout: 30000 });
        if (result.status !== 0)
            throw new Error('Built service planner failed: ' + result.stderr);
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        const plan = JSON.parse(result.stdout) as {
            id: string;
            digest: string;
            formatVersion: number;
        };
        expect(plan.id).toBe('plan-' + plan.digest);
        expect(plan.formatVersion).toBe(3);
        expect(existsSync(join(fixture.installation, '.cordis/credentials'))).toBe(false);
    }
    finally {
        fixture.close();
    } }
    async permissions(): Promise<void> { const fixture = await new ServiceReleaseFixture().services(); try {
        const { ComposeDeploymentHost } = await import('../src/diagnose.js');
        const module = await import('../src/service-plan.js') as unknown as {
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
const suite = new ServicePlanTests();
test('smoke: default built host saves deterministic five-instance plan without runtime listeners or credentials', suite.program.bind(suite));
test('integration: format3 plan read-back rejects malformed and non-private records and doctor recognizes the store', suite.permissions.bind(suite));
class ServicePlanBoundaryTests {
    async additive(): Promise<void> { const { ComposeDeploymentHost } = await import('../src/diagnose.js'), { ServiceSchemas } = await import('@treeseed-cordis/sdk'), fixture = await new ServiceReleaseFixture().services(); try {
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
    async blocked(): Promise<void> { const { ComposeDeploymentHost } = await import('../src/diagnose.js'), fixture = await new ServiceReleaseFixture().services(); try {
        fixture.configuration.credentialReferences = ['secret://instance-0/missing'];
        await expect(new ComposeDeploymentHost().plan(fixture.configuration)).rejects.toThrow();
        expect(existsSync(fixture.installation)).toBe(false);
    }
    finally {
        fixture.close();
    } }
    async migration(): Promise<void> { const { ComposeDeploymentHost } = await import('../src/diagnose.js'), { PreparedReleaseFixture } = await import('./release-fixture.js'), legacy = await new PreparedReleaseFixture().prepare(), fixture = await new ServiceReleaseFixture().services(); try {
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
const boundaries = new ServicePlanBoundaryTests();
test('integration: unrelated private service additions preserve existing service generations', boundaries.additive.bind(boundaries));
test('integration: blocked generic plans create no journal state', boundaries.blocked.bind(boundaries));
test('integration: generic planning refuses implicit legacy migration and preserves old bytes', boundaries.migration.bind(boundaries));
class ReadonlyCommands extends DockerCommands {
    calls = 0;
    override execute(args: string[]): string | null { const operation = args[0] === '--context' ? args.slice(2) : args, kind = operation[0], subcommand = operation[1]; if (!(kind === 'context' && subcommand === 'inspect' || kind === 'info' || kind === 'compose' && subcommand === 'version' || kind === 'ps' || ['network', 'volume'].includes(kind ?? '') && subcommand === 'ls'))
        throw new Error('Modifying engine operation refused'); this.calls++; return super.execute(args); }
}
class ServiceCommandTests {
    async readonly(): Promise<void> { const { ComposeDeploymentHost } = await import('../src/diagnose.js'), fixture = await new ServiceReleaseFixture().services(), commands = new ReadonlyCommands(); try {
        const plan = await new ComposeDeploymentHost(commands).plan(fixture.configuration);
        expect(plan.formatVersion).toBe(3);
        expect(commands.calls).toBeGreaterThan(0);
    }
    finally {
        fixture.close();
    } }
}
const commands = new ServiceCommandTests();
test('integration: generic planner uses only read-only engine commands', commands.readonly.bind(commands));
